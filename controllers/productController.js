const mongoose = require('mongoose');
const Product = require('../models/Product');
const Category = require('../models/Category');
const StockEntry = require('../models/StockEntry');
const Supplier = require('../models/Supplier');
const SupplierCreditPayment = require('../models/SupplierCreditPayment');
const Expense = require('../models/Expense');
const BusinessDetails = require('../models/BusinessDetails');
const AuditLog = require('../models/AuditLog');
const InventoryEditRequest = require('../models/InventoryEditRequest');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { nextObjectId } = require('../utils/objectId');
const { parseCreditPeriod } = require('../utils/creditPeriod');
const { notifyStockCreditExpiry } = require('../utils/stockCreditNotifications');
const { generateExpenseNumber } = require('./expenseController');
const { ensureExpenseCategories } = require('../utils/defaultExpenseCategories');

const createNotification = async (recipientId, type, title, message, relatedId = null) => {
    try {
        await Notification.create({ recipient: recipientId, type, title, message, relatedId });
    } catch (err) { console.error('Notification error:', err); }
};

const emptyStockPayment = (error = null) => ({
    acquisitionType: 'cash',
    advanceAmount: 0,
    creditAmount: 0,
    creditPeriod: '',
    creditDueDate: null,
    error,
});

const parseStockPayment = (
    acquisitionType,
    creditPeriod,
    advanceAmount,
    totalAmount,
    fallback = {},
    baseDate = new Date(),
    creditDueDate = undefined
) => {
    const rawType = acquisitionType !== undefined ? acquisitionType : fallback.acquisitionType;
    const type = rawType === 'credit' || rawType === 'advance' ? rawType : 'cash';

    if (type === 'cash') return emptyStockPayment();

    const rawPeriod = creditPeriod !== undefined ? creditPeriod : fallback.creditPeriod;
    let parsedDueDate;
    let parsedPeriod = '';

    if (rawPeriod !== undefined && rawPeriod !== null && String(rawPeriod).trim() !== '') {
        const period = parseCreditPeriod(rawPeriod, baseDate);
        if (period.error) return emptyStockPayment(period.error);
        parsedDueDate = period.dueDate;
        parsedPeriod = period.label;
    } else {
        const rawDueDate = creditDueDate !== undefined ? creditDueDate : fallback.creditDueDate;
        if (!rawDueDate) return emptyStockPayment('Credit period is required');
        parsedDueDate = new Date(rawDueDate);
        if (Number.isNaN(parsedDueDate.getTime())) return emptyStockPayment('Invalid credit due date');
    }

    const total = Number(totalAmount) || 0;

    if (type === 'credit') {
        return {
            acquisitionType: 'credit',
            advanceAmount: 0,
            creditAmount: total,
            creditPeriod: parsedPeriod,
            creditDueDate: parsedDueDate,
            error: null,
        };
    }

    const rawAdvance = advanceAmount !== undefined ? advanceAmount : fallback.advanceAmount;
    const parsedAdvance = Number(rawAdvance);
    if (!Number.isFinite(parsedAdvance) || parsedAdvance <= 0 || parsedAdvance >= total) {
        return emptyStockPayment('Advance amount must be greater than zero and less than the total stock value');
    }

    return {
        acquisitionType: 'advance',
        advanceAmount: parsedAdvance,
        creditAmount: total - parsedAdvance,
        creditPeriod: parsedPeriod,
        creditDueDate: parsedDueDate,
        error: null,
    };
};

const getStockExpenseCategory = async () => {
    const details = await BusinessDetails.findOne();
    const categories = ensureExpenseCategories(details) || [];
    const normalized = (value) => String(value || '').trim().toLowerCase();
    const assetCategories = categories.filter((cat) => normalized(cat?.name) === 'asset purchase');
    const activeAsset = assetCategories.find((cat) => cat?.isActive !== false);
    if (activeAsset) return String(activeAsset.name).trim();
    if (assetCategories.length > 0) return String(assetCategories[0].name).trim();

    const activeCategory = categories.find((cat) => cat && cat.isActive !== false && normalized(cat.name));
    return activeCategory ? String(activeCategory.name).trim() : 'Other';
};

const getSupplierName = async (supplierRef) => {
    if (!supplierRef || !mongoose.isValidObjectId(supplierRef)) return '';
    const supplier = await Supplier.findById(supplierRef).select('name').lean();
    return supplier?.name || '';
};

const syncStockExpense = async ({ entry, product, supplierName, createdBy }) => {
    const total = Number(entry.quantity || 0) * Number(entry.buyingPrice || 0);
    let desiredAmount = 0;
    if (entry.acquisitionType === 'cash') desiredAmount = total;
    else if (entry.acquisitionType === 'advance') desiredAmount = Number(entry.advanceAmount || 0);

    if (desiredAmount <= 0) {
        if (entry.expenseRef) {
            await Expense.findByIdAndUpdate(entry.expenseRef, {
                $set: {
                    status: 'void',
                    voidNote: 'Stock payment changed to credit',
                    voidedBy: createdBy,
                },
            });
        }
        return { expenseRef: null, expenseNumber: '' };
    }

    const isAdvance = entry.acquisitionType === 'advance';
    const payload = {
        name: 'Stock purchase — ' + product.name + ' (' + entry.batchRef + ')' + (isAdvance ? ' — Advance' : ''),
        paidTo: supplierName || 'Supplier',
        billNumber: entry.supplierInvoiceNumber || entry.supplierDeliveryNumber || entry.batchRef,
        categoryName: await getStockExpenseCategory(),
        purpose: 'asset',
        projectRef: null,
        amount: desiredAmount,
        paymentMethod: 'cash',
        chequeNumber: '',
        notes: 'Auto-generated for stock entry ' + entry.batchRef + '. Qty: ' + entry.quantity + ', unit price: ' + entry.buyingPrice + '. Advance: ' + (entry.advanceAmount || 0) + ', credit balance: ' + (entry.creditAmount || 0) + '.',
        expenseDate: new Date(),
    };

    let doc;
    if (entry.expenseRef) {
        doc = await Expense.findByIdAndUpdate(
            entry.expenseRef,
            { $set: payload },
            { new: true, runValidators: true }
        );
        return { expenseRef: doc?._id || entry.expenseRef, expenseNumber: doc?.expenseNumber || '' };
    }

    const expenseNumber = await generateExpenseNumber();
    doc = await Expense.create({ ...payload, expenseNumber, status: 'recorded', createdBy });
    return { expenseRef: doc._id, expenseNumber: doc.expenseNumber };
};


// ── CATEGORY METHODS ─────────────────────────────────────────────────────────

exports.createCategory = async (req, res) => {
    try {
        const { name, parentCategory } = req.body;
        const code = await nextObjectId(Category, 'Category', 'code');
        const category = await Category.create({ name, code, parentCategory: parentCategory || null });
        res.status(201).json({ success: true, data: category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getCategories = async (req, res) => {
    try {
        const categories = await Category.find().populate('parentCategory');
        res.status(200).json({ success: true, data: categories });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const { reason, ...updateData } = req.body;
        const before = await Category.findById(req.params.id);
        if (!before) return res.status(404).json({ success: false, message: 'Category not found' });

        const category = await Category.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true, runValidators: true }
        );

        await AuditLog.create({
            action: 'CATEGORY_EDIT',
            targetType: 'Category',
            targetId: category._id,
            targetName: category.name,
            details: { before: before.toObject(), after: category.toObject() },
            reason: reason || 'Direct edit by admin',
            performedBy: req.user._id
        });

        res.status(200).json({ success: true, data: category });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const productsCount = await Product.countDocuments({ category: req.params.id });
        if (productsCount > 0) {
            return res.status(400).json({ success: false, message: 'Cannot delete category with associated products' });
        }
        await Category.findByIdAndDelete(req.params.id);
        res.status(200).json({ success: true, message: 'Category deleted' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// ── PRODUCT METHODS ───────────────────────────────────────────────────────────

exports.createProduct = async (req, res) => {
    try {
        const { name, category, price, currencyType, isTaxIncluded, description, warrantyPeriod } = req.body;

        const categoryDoc = await Category.findById(category);
        if (!categoryDoc) return res.status(404).json({ success: false, message: 'Category not found' });

        const productId = await nextObjectId(Product, 'Product', 'productId');

        const product = await Product.create({
            productId,
            name,
            category,
            price,
            currencyType,
            isTaxIncluded,
            description: description || '',
            warrantyPeriod: warrantyPeriod || '',
            quantity: 0,
        });

        res.status(201).json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getProducts = async (req, res) => {
    try {
        const includeSerials = String(req.query.includeSerials || '').toLowerCase() === 'true';
        const products = await Product.find()
            .populate('category', 'name code')
            .sort({ createdAt: -1 })
            .lean();

        if (!includeSerials) {
            return res.status(200).json({ success: true, data: products });
        }

        // Attach available serial numbers only when explicitly requested (invoice/quotation forms)
        const productIds = products.map(p => p._id);
        const stockEntries = await StockEntry.find({
            product: { $in: productIds },
            hasSerialNumbers: true,
            'serialNumbers.0': { $exists: true },
        }).select('product serialNumbers').lean();

        const serialsByProduct = {};
        for (const entry of stockEntries) {
            const pid = entry.product.toString();
            if (!serialsByProduct[pid]) serialsByProduct[pid] = [];
            serialsByProduct[pid].push(...(entry.serialNumbers || []));
        }

        const enrichedProducts = products.map(p => ({
            ...p,
            availableSerials: serialsByProduct[p._id.toString()] || [],
        }));

        res.status(200).json({ success: true, data: enrichedProducts });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateProduct = async (req, res) => {
    try {
        // Prevent direct quantity manipulation — use stock entries
        const { quantity, reason, ...updateData } = req.body;
        const before = await Product.findById(req.params.id);
        if (!before) return res.status(404).json({ success: false, message: 'Product not found' });

        const product = await Product.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true, runValidators: true }
        );

        await AuditLog.create({
            action: 'PRODUCT_EDIT',
            targetType: 'Product',
            targetId: product._id,
            targetName: product.name,
            details: { before: before.toObject(), after: product.toObject() },
            reason: reason || 'Direct edit by admin',
            performedBy: req.user._id
        });

        res.status(200).json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteProduct = async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
        // Cascade-delete associated stock entries
        await StockEntry.deleteMany({ product: req.params.id });
        res.status(200).json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// ── STOCK ENTRY METHODS ───────────────────────────────────────────────────────

exports.addStockEntry = async (req, res) => {
    try {
        const productId = req.params.id;
        const {
            location,
            buyingPrice,
            quantity,
            warrantyPeriod,
            serialNumbers,
            notes,
            supplierRef,
            supplierInvoiceNumber,
            supplierDeliveryNumber,
            acquisitionType,
            creditPeriod,
            creditDueDate,
            advanceAmount,
        } = req.body;

        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

        const qty = parseInt(quantity, 10);
        if (isNaN(qty) || qty < 1) {
            return res.status(400).json({ success: false, message: 'Quantity must be a positive integer' });
        }

        const supplierInvoice = supplierInvoiceNumber ? String(supplierInvoiceNumber).trim().toUpperCase() : '';
        if (!supplierInvoice) {
            return res.status(400).json({ success: false, message: 'Supplier invoice number is required' });
        }

        const total = qty * Number(buyingPrice || 0);
        const payment = parseStockPayment(acquisitionType, creditPeriod, advanceAmount, total, {}, new Date(), creditDueDate);
        if (payment.error) return res.status(400).json({ success: false, message: payment.error });

        // ── Store location validation ─────────────────────────────────────────
        if (location && location.trim()) {
            const biz = await BusinessDetails.findOne();
            const stores = biz?.stores || [];
            if (stores.length > 0) {
                const storeNames = stores.map(s => s.name.trim().toLowerCase());
                if (!storeNames.includes(location.trim().toLowerCase())) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid location. Available stores: ${stores.map(s => s.name).join(', ')}`
                    });
                }
            }
        }

        // ── Serial number validation ──────────────────────────────────────────
        let processedSerials = [];
        if (Array.isArray(serialNumbers) && serialNumbers.length > 0) {
            processedSerials = serialNumbers
                .map((s) => String(s).trim().toUpperCase())
                .filter(Boolean);

            // Duplicate check within submitted list
            const uniqueSet = new Set(processedSerials);
            if (uniqueSet.size !== processedSerials.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Duplicate serial numbers found in the submitted list',
                });
            }

            // Count match check
            if (processedSerials.length !== qty) {
                return res.status(400).json({
                    success: false,
                    message: `Serial number count (${processedSerials.length}) must equal quantity (${qty})`,
                });
            }

            // Check against existing entries for this product
            const existingEntries = await StockEntry.find({ product: productId });
            const existingSerials = new Set(existingEntries.flatMap((e) => e.serialNumbers));
            const duplicates = processedSerials.filter((s) => existingSerials.has(s));
            if (duplicates.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `These serial numbers already exist: ${duplicates.join(', ')}`,
                });
            }
        }

        // Generate unique batch reference
        const batchRef = await nextObjectId(StockEntry, 'StockEntry', 'batchRef');

        let expenseRef = null;
        let expenseNumber = '';
        if (payment.acquisitionType === 'cash' || payment.acquisitionType === 'advance') {
            const supplierName = await getSupplierName(supplierRef);
            const expense = await syncStockExpense({
                entry: {
                    batchRef,
                    quantity: qty,
                    buyingPrice,
                    supplierInvoiceNumber,
                    supplierDeliveryNumber,
                    advanceAmount: payment.advanceAmount,
                    creditAmount: payment.creditAmount,
                    acquisitionType: payment.acquisitionType,
                    expenseRef: null,
                },
                product,
                supplierName,
                createdBy: req.user._id,
            });
            expenseRef = expense.expenseRef;
            expenseNumber = expense.expenseNumber;
        }

        const entry = await StockEntry.create({
            product: productId,
            batchRef,
            location: location || '',
            buyingPrice: buyingPrice || 0,
            quantity: qty,
            warrantyPeriod: warrantyPeriod || '',
            serialNumbers: processedSerials,
            hasSerialNumbers: processedSerials.length > 0,
            supplierRef: supplierRef || null,
            supplierInvoiceNumber: supplierInvoice,
            supplierDeliveryNumber: supplierDeliveryNumber
                ? String(supplierDeliveryNumber).trim().toUpperCase()
                : '',
            notes: notes || '',
            acquisitionType: payment.acquisitionType,
            advanceAmount: payment.advanceAmount,
            creditAmount: payment.creditAmount,
            creditPeriod: payment.creditPeriod,
            creditDueDate: payment.creditDueDate,
            creditExpiryNotifiedAt: null,
            expenseRef,
            expenseNumber,
            addedBy: req.user._id,
        });

        if (payment.creditAmount > 0) {
            setImmediate(() => {
                notifyStockCreditExpiry().catch((err) => console.error('Stock credit notification error:', err));
            });
        }

        // Atomically increment product quantity
        await Product.findByIdAndUpdate(productId, { $inc: { quantity: qty } });

        const populated = await StockEntry.findById(entry._id)
            .populate('addedBy', 'name username')
            .populate('supplierRef', 'name supplierId')
            .populate('expenseRef', 'expenseNumber status amount');
        res.status(201).json({ success: true, data: populated });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getStockEntries = async (req, res) => {
    try {
        const entries = await StockEntry.find({ product: req.params.id })
            .populate('addedBy', 'name username')
            .populate('supplierRef', 'name supplierId')
            .populate('expenseRef', 'expenseNumber status amount')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: entries });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// ── STOCK ENTRY EDIT (admin/root only — direct) ───────────────────────────────

exports.updateStockEntry = async (req, res) => {
    try {
        const { reason, ...changes } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'Reason for modification is required' });

        const entry = await StockEntry.findById(req.params.entryId);
        if (!entry) return res.status(404).json({ success: false, message: 'Stock entry not found' });

        const before = entry.toObject();

        const rawSupplierInvoice = changes.supplierInvoiceNumber !== undefined
            ? changes.supplierInvoiceNumber
            : before.supplierInvoiceNumber;
        const supplierInvoice = rawSupplierInvoice ? String(rawSupplierInvoice).trim().toUpperCase() : '';
        if (!supplierInvoice) {
            return res.status(400).json({ success: false, message: 'Supplier invoice number is required' });
        }
        changes.supplierInvoiceNumber = supplierInvoice;

        // Prevent arbitrary product reassignment
        const allowed = ['location', 'buyingPrice', 'quantity', 'notes', 'supplierInvoiceNumber', 'serialNumbers', 'acquisitionType', 'creditPeriod', 'advanceAmount'];
        allowed.forEach(f => { if (changes[f] !== undefined) entry[f] = changes[f]; });

        const payment = parseStockPayment(
            entry.acquisitionType,
            changes.creditPeriod !== undefined ? changes.creditPeriod : before.creditPeriod,
            changes.advanceAmount !== undefined ? changes.advanceAmount : before.advanceAmount,
            Number(entry.quantity) * Number(entry.buyingPrice || 0),
            { acquisitionType: entry.acquisitionType, advanceAmount: before.advanceAmount, creditPeriod: before.creditPeriod, creditDueDate: before.creditDueDate },
            new Date(before.createdAt || Date.now())
        );
        if (payment.error) return res.status(400).json({ success: false, message: payment.error });

        entry.acquisitionType = payment.acquisitionType;
        entry.advanceAmount = payment.advanceAmount;
        entry.creditAmount = payment.creditAmount;
        entry.creditPeriod = payment.creditPeriod;
        entry.creditDueDate = payment.creditDueDate;

        const beforeDue = before.creditDueDate ? new Date(before.creditDueDate).getTime() : null;
        const afterDue = payment.creditDueDate ? new Date(payment.creditDueDate).getTime() : null;
        if (payment.acquisitionType !== before.acquisitionType ||
            payment.advanceAmount !== Number(before.advanceAmount || 0) ||
            payment.creditAmount !== Number(before.creditAmount || 0) ||
            (before.creditPeriod || '') !== payment.creditPeriod ||
            beforeDue !== afterDue) {
            entry.creditExpiryNotifiedAt = null;
        }

        // Sync product-level quantity if quantity changed
        if (changes.quantity !== undefined) {
            const diff = changes.quantity - before.quantity;
            await Product.findByIdAndUpdate(entry.product, { $inc: { quantity: diff } });
        }

        const product = await Product.findById(entry.product);
        const supplierName = await getSupplierName(entry.supplierRef);
        const expense = await syncStockExpense({
            entry,
            product: product || { name: '' },
            supplierName,
            createdBy: req.user._id,
        });
        entry.expenseRef = expense.expenseRef;
        entry.expenseNumber = expense.expenseNumber;

        await entry.save();

        if (entry.creditAmount > 0) {
            setImmediate(() => {
                notifyStockCreditExpiry().catch((err) => console.error('Stock credit notification error:', err));
            });
        }

        await AuditLog.create({
            action: 'STOCK_EDIT',
            targetType: 'StockEntry',
            targetId: entry._id,
            targetName: entry.batchRef,
            details: { before, after: entry.toObject() },
            reason,
            performedBy: req.user._id
        });

        res.status(200).json({ success: true, data: entry });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// ── INVENTORY EDIT REQUESTS (standard user → approval workflow) ────────────────

exports.createInventoryRequest = async (req, res) => {
    try {
        const { type, targetId, targetName, proposedChanges, reason } = req.body;
        if (!type || !targetId || !proposedChanges || !reason) {
            return res.status(400).json({ success: false, message: 'type, targetId, proposedChanges, and reason are required' });
        }

        const request = await InventoryEditRequest.create({
            type, targetId, targetName: targetName || '', proposedChanges, reason,
            requestedBy: req.user._id
        });

        // Notify all admins/root users
        const admins = await User.find({ role: { $in: ['admin', 'root'] } });
        for (const admin of admins) {
            await createNotification(
                admin._id, 'inventory_request', 'Inventory Edit Request',
                `${req.user.firstName} ${req.user.lastName} submitted a ${type} edit request for "${targetName || targetId}". Reason: ${reason}`,
                request._id
            );
        }

        res.status(201).json({ success: true, message: 'Edit request submitted for approval', data: request });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getInventoryRequests = async (req, res) => {
    try {
        const requests = await InventoryEditRequest.find({ status: 'Pending' })
            .populate('requestedBy', 'firstName lastName email')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: requests });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.approveInventoryRequest = async (req, res) => {
    try {
        const request = await InventoryEditRequest.findById(req.params.requestId)
            .populate('requestedBy');
        if (!request || request.status !== 'Pending') {
            return res.status(404).json({ success: false, message: 'Pending request not found' });
        }

        const { type, targetId, proposedChanges, reason } = request;
        let before = null;

        if (type === 'Product') {
            const doc = await Product.findById(targetId);
            before = doc?.toObject();
            const { quantity, ...safe } = proposedChanges;
            await Product.findByIdAndUpdate(targetId, safe, { new: true, runValidators: true });
        } else if (type === 'Category') {
            const doc = await Category.findById(targetId);
            before = doc?.toObject();
            await Category.findByIdAndUpdate(targetId, proposedChanges, { new: true, runValidators: true });
        } else if (type === 'StockEntry') {
            const doc = await StockEntry.findById(targetId);
            before = doc?.toObject();
            const allowed = ['location', 'buyingPrice', 'quantity', 'notes', 'supplierInvoiceNumber', 'serialNumbers', 'acquisitionType', 'creditPeriod', 'advanceAmount'];
            const safe = {};
            allowed.forEach(f => { if (proposedChanges[f] !== undefined) safe[f] = proposedChanges[f]; });

            const rawSupplierInvoice = safe.supplierInvoiceNumber !== undefined
                ? safe.supplierInvoiceNumber
                : doc?.supplierInvoiceNumber;
            const supplierInvoice = rawSupplierInvoice ? String(rawSupplierInvoice).trim().toUpperCase() : '';
            if (!supplierInvoice) {
                return res.status(400).json({ success: false, message: 'Supplier invoice number is required' });
            }
            safe.supplierInvoiceNumber = supplierInvoice;

            const quantity = safe.quantity !== undefined ? safe.quantity : doc?.quantity;
            const buyingPrice = safe.buyingPrice !== undefined ? safe.buyingPrice : doc?.buyingPrice;
            const payment = parseStockPayment(
                safe.acquisitionType !== undefined ? safe.acquisitionType : doc?.acquisitionType,
                safe.creditPeriod !== undefined ? safe.creditPeriod : doc?.creditPeriod,
                safe.advanceAmount !== undefined ? safe.advanceAmount : doc?.advanceAmount,
                Number(quantity) * Number(buyingPrice || 0),
                { acquisitionType: doc?.acquisitionType, advanceAmount: doc?.advanceAmount, creditPeriod: doc?.creditPeriod, creditDueDate: doc?.creditDueDate },
                new Date(doc?.createdAt || Date.now())
            );
            if (payment.error) return res.status(400).json({ success: false, message: payment.error });
            safe.acquisitionType = payment.acquisitionType;
            safe.advanceAmount = payment.advanceAmount;
            safe.creditAmount = payment.creditAmount;
            safe.creditPeriod = payment.creditPeriod;
            safe.creditDueDate = payment.creditDueDate;
            safe.creditExpiryNotifiedAt = null;

            // sync product quantity if changed
            if (safe.quantity !== undefined && doc) {
                const diff = safe.quantity - doc.quantity;
                await Product.findByIdAndUpdate(doc.product, { $inc: { quantity: diff } });
            }
            const updated = await StockEntry.findByIdAndUpdate(targetId, safe, { new: true });
            if (updated) {
                const product = await Product.findById(updated.product);
                const supplierName = await getSupplierName(updated.supplierRef);
                const expense = await syncStockExpense({
                    entry: updated,
                    product: product || { name: '' },
                    supplierName,
                    createdBy: req.user._id,
                });
                updated.expenseRef = expense.expenseRef;
                updated.expenseNumber = expense.expenseNumber;
                await updated.save();

                if (updated.creditAmount > 0) {
                    setImmediate(() => {
                        notifyStockCreditExpiry().catch((err) => console.error('Stock credit notification error:', err));
                    });
                }
            }
        }

        request.status = 'Approved';
        request.reviewedBy = req.user._id;
        request.reviewedAt = Date.now();
        await request.save();

        await AuditLog.create({
            action: 'INVENTORY_REQUEST_APPROVED',
            targetType: type,
            targetId,
            targetName: request.targetName,
            details: { before, proposedChanges, approvedBy: req.user._id },
            reason,
            performedBy: req.user._id
        });

        // Notify requester
        await createNotification(
            request.requestedBy._id, 'approval', 'Inventory Edit Approved',
            `Your edit request for "${request.targetName}" has been approved by ${req.user.firstName} ${req.user.lastName}.`
        );

        res.status(200).json({ success: true, message: 'Inventory edit applied and logged' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const CREDIT_PAYMENT_EPSILON = 0.000001;

const getCreditDueTime = (value) => {
    if (!value) return Number.POSITIVE_INFINITY;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

const getCreditCreatedTime = (value) => {
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
};

const compareCreditEntries = (first, second) => {
    const firstDue = getCreditDueTime(first.creditDueDate);
    const secondDue = getCreditDueTime(second.creditDueDate);
    if (firstDue !== secondDue) return firstDue - secondDue;
    return getCreditCreatedTime(first.createdAt) - getCreditCreatedTime(second.createdAt);
};

exports.getSupplierCredits = async (req, res) => {
    try {
        const suppliers = await Supplier.find().select('name supplierId bankDetails').lean();
        const creditTotals = await StockEntry.aggregate([
            {
                $match: {
                    supplierRef: { $ne: null },
                    creditAmount: { $gt: 0 }
                }
            },
            {
                $group: {
                    _id: '$supplierRef',
                    totalCredit: { $sum: '$creditAmount' },
                    entryCount: { $sum: 1 },
                    oldestDueDate: { $min: '$creditDueDate' }
                }
            }
        ]);

        const totalsBySupplier = new Map(
            creditTotals.map((item) => [String(item._id), item])
        );

        const data = suppliers
            .map((supplier) => {
                const totals = totalsBySupplier.get(String(supplier._id));
                return {
                    supplier: {
                        _id: supplier._id,
                        name: supplier.name,
                        supplierId: supplier.supplierId,
                        bankDetails: supplier.bankDetails || {}
                    },
                    totalCredit: Number(totals?.totalCredit || 0),
                    entryCount: Number(totals?.entryCount || 0),
                    oldestDueDate: totals?.oldestDueDate ?? null
                };
            })
            .filter((row) => row.totalCredit > 0);

        data.sort((first, second) =>
            second.totalCredit - first.totalCredit ||
            String(first.supplier.name || '').localeCompare(String(second.supplier.name || ''))
        );

        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getSupplierCreditEntries = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid supplier id' });
        }

        const supplier = await Supplier.findById(req.params.id).select('name supplierId bankDetails').lean();
        if (!supplier) {
            return res.status(404).json({ success: false, message: 'Supplier not found' });
        }

        const entries = await StockEntry.find({
            creditAmount: { $gt: 0 },
            supplierRef: req.params.id
        })
            .populate('product', 'name productId')
            .lean();
        entries.sort(compareCreditEntries);

        const totalCredit = entries.reduce(
            (sum, entry) => sum + Number(entry.creditAmount || 0),
            0
        );

        res.status(200).json({
            success: true,
            data: {
                supplier: {
                    _id: supplier._id,
                    name: supplier.name,
                    supplierId: supplier.supplierId,
                    bankDetails: supplier.bankDetails || {}
                },
                totalCredit,
                entries: entries.map((entry) => ({
                    _id: entry._id,
                    batchRef: entry.batchRef,
                    productName: entry.product?.name || '',
                    productId: entry.product?.productId || '',
                    creditAmount: Number(entry.creditAmount || 0),
                    creditPeriod: entry.creditPeriod || '',
                    creditDueDate: entry.creditDueDate ?? null,
                    supplierInvoiceNumber: entry.supplierInvoiceNumber || '',
                    createdAt: entry.createdAt,
                    expenseNumber: entry.expenseNumber || ''
                }))
            }
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.paySupplierCredit = async (req, res) => {
    try {
        const { amount, paymentMethod, chequeNumber, notes } = req.body;

        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid supplier id' });
        }

        const supplier = await Supplier.findById(req.params.id).select('name supplierId').lean();
        if (!supplier) {
            return res.status(404).json({ success: false, message: 'Supplier not found' });
        }

        const entries = await StockEntry.find({
            creditAmount: { $gt: 0 },
            supplierRef: req.params.id
        });
        entries.sort(compareCreditEntries);

        const total = entries.reduce(
            (sum, entry) => sum + Number(entry.creditAmount || 0),
            0
        );
        const parsedAmount = Number(amount);

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
        }
        if (parsedAmount > total + CREDIT_PAYMENT_EPSILON) {
            return res.status(400).json({ success: false, message: 'Amount cannot exceed outstanding credit' });
        }
        if (!['cash', 'cheque', 'bank'].includes(paymentMethod)) {
            return res.status(400).json({ success: false, message: 'Invalid payment method' });
        }

        const normalizedChequeNumber = paymentMethod === 'cheque'
            ? String(chequeNumber || '').trim()
            : '';
        if (paymentMethod === 'cheque' && !normalizedChequeNumber) {
            return res.status(400).json({ success: false, message: 'Cheque number is required for cheque payments' });
        }

        const normalizedNotes = notes ? String(notes).trim() : '';
        const allocations = [];
        const allocatedEntries = [];
        let remaining = parsedAmount;

        for (const entry of entries) {
            if (remaining <= 0) break;
            const available = Number(entry.creditAmount || 0);
            if (available <= 0) continue;

            const applied = Math.min(available, remaining);
            const newEntryCredit = Math.max(0, available - applied);
            entry.creditAmount = newEntryCredit <= CREDIT_PAYMENT_EPSILON ? 0 : newEntryCredit;
            remaining = remaining - applied <= CREDIT_PAYMENT_EPSILON ? 0 : Math.max(0, remaining - applied);
            allocations.push({ stockEntry: entry._id, amount: applied });
            allocatedEntries.push(entry);
            await StockEntry.findByIdAndUpdate(entry._id, { $set: { creditAmount: entry.creditAmount } });
        }

        const expenseNumber = await generateExpenseNumber();
        const billNumbers = [...new Set(
            allocatedEntries
                .map((entry) => String(entry.supplierInvoiceNumber || '').trim())
                .filter(Boolean)
        )];
        const billNumber = billNumbers.length > 0
            ? billNumbers.join(', ')
            : `CREDIT-${supplier.supplierId || supplier._id}-${Date.now()}`;
        const categoryName = await getStockExpenseCategory();
        const creditNote = `Credit payment for ${allocatedEntries
            .map((entry) => entry.batchRef)
            .filter(Boolean)
            .join(', ')}`;

        const expense = await Expense.create({
            expenseNumber,
            name: `Supplier credit payment — ${supplier.name}`,
            paidTo: supplier.name,
            billNumber,
            categoryName,
            purpose: 'asset',
            projectRef: null,
            amount: parsedAmount,
            paymentMethod: paymentMethod === 'bank' ? 'bank_transfer' : paymentMethod,
            chequeNumber: paymentMethod === 'cheque' ? normalizedChequeNumber : '',
            notes: [normalizedNotes, creditNote].filter(Boolean).join(' | '),
            expenseDate: new Date(),
            status: 'recorded',
            createdBy: req.user._id
        });

        const payment = await SupplierCreditPayment.create({
            supplier: supplier._id,
            amount: parsedAmount,
            paymentMethod,
            chequeNumber: normalizedChequeNumber,
            notes: normalizedNotes,
            expenseRef: expense._id,
            expenseNumber: expense.expenseNumber,
            allocations,
            createdBy: req.user._id
        });

        await AuditLog.create({
            action: 'SUPPLIER_CREDIT_PAYMENT',
            targetType: 'Supplier',
            targetId: supplier._id,
            targetName: supplier.name,
            details: {
                amount: parsedAmount,
                paymentMethod,
                expenseNumber: expense.expenseNumber,
                allocations
            },
            performedBy: req.user._id
        });

        res.status(200).json({
            success: true,
            data: {
                payment,
                expenseNumber: expense.expenseNumber,
                remainingCredit: total - parsedAmount
            }
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.rejectInventoryRequest = async (req, res) => {
    try {
        const request = await InventoryEditRequest.findById(req.params.requestId)
            .populate('requestedBy');
        if (!request || request.status !== 'Pending') {
            return res.status(404).json({ success: false, message: 'Pending request not found' });
        }

        request.status = 'Rejected';
        request.reviewedBy = req.user._id;
        request.reviewedAt = Date.now();
        await request.save();

        await AuditLog.create({
            action: 'INVENTORY_REQUEST_REJECTED',
            targetType: request.type,
            targetId: request.targetId,
            targetName: request.targetName,
            details: { proposedChanges: request.proposedChanges },
            reason: request.reason,
            performedBy: req.user._id
        });

        await createNotification(
            request.requestedBy._id, 'rejection', 'Inventory Edit Rejected',
            `Your edit request for "${request.targetName}" has been rejected by ${req.user.firstName} ${req.user.lastName}.`
        );

        res.status(200).json({ success: true, message: 'Inventory edit request rejected' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

