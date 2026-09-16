const Invoice = require('../models/Invoice');
const InvoiceDeleteRequest = require('../models/InvoiceDeleteRequest');
const CashReceipt = require('../models/CashReceipt');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Product = require('../models/Product');
const StockEntry = require('../models/StockEntry');
const Project = require('../models/Project');
const Warranty = require('../models/Warranty');
const BusinessDetails = require('../models/BusinessDetails');
const DeliveryNote = require('../models/DeliveryNote');
const Quotation = require('../models/Quotation');
const SalesReturnNote = require('../models/SalesReturnNote');
const {
    enrichItemsWithUnitCost,
    enrichItemsWithUnitCostFromDN,
} = require('../utils/stockCost');
const { generateReceiptNumber } = require('./cashReceiptController');

const createNotification = async (recipientId, type, title, message, relatedId = null) => {
    try {
        await Notification.create({
            recipient: recipientId,
            type,
            title,
            message,
            relatedId
        });
    } catch (err) {
        console.error('Notification error:', err);
    }
};

const validateAdvanceReceipts = async (advanceReceipts, projectId) => {
    if (!advanceReceipts || advanceReceipts.length === 0) return { errors: [], receipts: [], sum: 0 };
    const errors = [];
    const receipts = [];
    let sum = 0;

    for (const item of advanceReceipts) {
        const rid = item?.receiptRef;
        if (!rid) { errors.push('Advance receipt reference is missing'); continue; }

        const receipt = await CashReceipt.findById(rid);
        if (!receipt) { errors.push('A selected advance cash receipt was not found'); continue; }
        if (receipt.status !== 'issued') { errors.push(`Receipt ${receipt.receiptNumber || ''} is not issued (it is ${receipt.status})`); continue; }
        if (receipt.appliedToInvoice) { errors.push(`Receipt ${receipt.receiptNumber || ''} is already applied to another invoice`); continue; }
        if (String(receipt.projectRef || '') !== String(projectId)) { errors.push(`Receipt ${receipt.receiptNumber || ''} does not belong to the selected project`); continue; }

        const amount = Number(item.amount);
        if (!amount || amount <= 0) { errors.push(`Receipt ${receipt.receiptNumber || ''} has an invalid advance amount`); continue; }
        sum += amount;
        receipts.push({ receiptRef: rid, amount });
    }

    return { errors, receipts, sum };
};

const resolveAdvancePayment = async (finalTotal, hasAdvancePayment, advanceAmount, advanceReceipts = [], projectId = null) => {
    const total = Number(finalTotal) || 0;
    const hasAdvance = !!hasAdvancePayment;

    let advance = hasAdvance ? Math.max(0, Number(advanceAmount) || 0) : 0;
    let receipts = [];

    if (hasAdvance && advanceReceipts && advanceReceipts.length > 0) {
        const valid = await validateAdvanceReceipts(advanceReceipts, projectId);
        if (valid.errors.length > 0) {
            return { error: valid.errors.join('; ') };
        }
        advance = valid.sum;
        receipts = valid.receipts;
    }

    if (hasAdvance && advance <= 0) {
        return { error: 'Advance amount must be greater than zero when advance payment is selected' };
    }
    if (advance > total) {
        return { error: 'Advance amount cannot exceed the invoice total' };
    }

    return {
        hasAdvancePayment: hasAdvance,
        advanceAmount: advance,
        balanceDue: Math.max(0, total - advance),
        advanceReceipts: receipts,
    };
};

// Mark advance cash receipts as consumed by an invoice
const applyAdvanceReceipts = async (invoiceId, advanceReceipts) => {
    for (const item of advanceReceipts || []) {
        if (!item?.receiptRef) continue;
        await CashReceipt.findByIdAndUpdate(item.receiptRef, {
            appliedToInvoice: invoiceId,
            appliedAmount: Number(item.amount) || 0
        });
    }
};

// Release advance cash receipts previously applied to an invoice (edit/delete)
const releaseAdvanceReceipts = async (invoiceId) => {
    await CashReceipt.updateMany(
        { appliedToInvoice: invoiceId },
        { $set: { appliedToInvoice: null, appliedAmount: 0 } }
    );
};

// Auto-generate a payment cash receipt when an invoice is created (paid methods only).
// The receipt's payment method mirrors the invoice's method, so dashboard method values
// are sourced from cash receipts.
const autoCreatePaymentReceipt = async (invoice, userId) => {
    if (!['cash', 'cheque', 'bank_transfer'].includes(invoice.paymentMethod)) return null;
    const amount = Number(invoice.balanceDue ?? invoice.finalTotal);
    if (!amount || amount <= 0) return null;

    const receiptNumber = await generateReceiptNumber();

    return CashReceipt.create({
        receiptNumber,
        receiptType: 'payment',
        receiptDate: invoice.invoiceDate || Date.now(),
        clientRef: invoice.clientRef || null,
        manualClientDetails: invoice.manualClientDetails || {},
        amountReceived: amount,
        paymentMethod: invoice.paymentMethod,
        chequeNumber: '',
        projectRef: invoice.projectId || null,
        quotationRef: invoice.quotationRef || null,
        invoiceRef: invoice._id,
        appliedToInvoice: null,
        appliedAmount: 0,
        description: `Auto-generated payment for invoice ${invoice.invoiceNumber}`,
        receivedBy: userId,
        status: 'issued',
        autoCreated: true
    });
};

// Void auto-generated receipts when the linked invoice is cancelled or replaced
const voidAutoReceiptForInvoice = async (invoiceId, userId, note) => {
    await CashReceipt.updateMany(
        { invoiceRef: invoiceId, autoCreated: true, status: 'issued' },
        {
            $set: {
                status: 'void',
                voidNote: note || 'Linked invoice cancelled',
                voidedBy: userId
            }
        }
    );
};

// Batch-compute how much each invoice has already received via issued payment receipts
const computePaidAmounts = async (invoiceIds) => {
    if (!invoiceIds || invoiceIds.length === 0) return {};
    const agg = await CashReceipt.aggregate([
        { $match: { invoiceRef: { $in: invoiceIds }, status: 'issued', receiptType: 'payment' } },
        { $group: { _id: '$invoiceRef', total: { $sum: '$amountReceived' } } }
    ]);
    const map = {};
    agg.forEach(a => { map[String(a._id)] = a.total; });
    return map;
};

const resolveInitialStatus = (paymentMethod, status, balanceDue) => {
    if (paymentMethod === 'cash') return 'Paid';
    if (balanceDue <= 0) return 'Paid';
    return status || 'Unpaid';
};

const EDIT_DELETE_WINDOW_DAYS = 30;

const isWithinEditWindow = (createdAt) => {
    const now = new Date();
    const diffMs = now - new Date(createdAt);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= EDIT_DELETE_WINDOW_DAYS;
};

// Restore stock from an invoice's items (used on edit/delete)
const reverseInvoiceStock = async (invoice) => {
    for (const item of invoice.items) {
        if (!item.productRef) continue;
        const hasSerials = item.serialNumbers && item.serialNumbers.length > 0;
        const isAutomatic = invoice.creationMethod === 'automatic';
        const isManual = invoice.creationMethod === 'manual';

        // Find the most recent stock entry for this product to restore into
        let entry = await StockEntry.findOne({ product: item.productRef }).sort({ createdAt: -1 });

        if (hasSerials) {
            const upperSerials = item.serialNumbers.map(s => s.toUpperCase());

            if (entry) {
                const newSerials = [...new Set([...entry.serialNumbers, ...upperSerials])];
                entry.serialNumbers = newSerials;
                if (isManual) {
                    entry.quantity += item.serialNumbers.length;
                }
                await entry.save();
            } else {
                // No existing stock entry — create one to hold the freed serials
                const product = await Product.findById(item.productRef).select('productId name');
                await StockEntry.create({
                    product: item.productRef,
                    batchRef: `${product?.productId || 'STOCK'}-RESTORED-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    quantity: item.serialNumbers.length,
                    serialNumbers: upperSerials,
                    hasSerialNumbers: true,
                    notes: `Restored from invoice ${invoice.invoiceNumber || ''}`,
                    addedBy: invoice.cancelledBy || invoice.createdBy
                });
            }
        }

        if (isAutomatic) {
            // Restore quantity to product level
            await Product.findByIdAndUpdate(item.productRef, {
                $inc: { quantity: item.quantity }
            });
            // Also try to restore to the stock entry
            if (entry) {
                entry.quantity += item.quantity;
                await entry.save();
            }
        } else if (isManual && hasSerials) {
            await Product.findByIdAndUpdate(item.productRef, {
                $inc: { quantity: item.serialNumbers.length }
            });
        }
    }
};

// Apply stock deductions for a set of items (used on create/edit)
const applyStockDeductions = async (items, creationMethod) => {
    for (const item of items) {
        if (item.productRef && (creationMethod === 'automatic' || (creationMethod === 'manual' && item.serialNumbers?.length > 0))) {
            let remainingQty = item.quantity;

            const stockEntries = await StockEntry.find({
                product: item.productRef,
                quantity: { $gt: 0 }
            }).sort({ createdAt: 1 });

            for (const entry of stockEntries) {
                if (remainingQty <= 0) break;

                if (item.serialNumbers && item.serialNumbers.length > 0) {
                    const serialsToRemove = item.serialNumbers.filter(sn =>
                        entry.serialNumbers.map(s => s.toUpperCase()).includes(sn.toUpperCase())
                    );
                    if (serialsToRemove.length > 0) {
                        entry.serialNumbers = entry.serialNumbers.filter(
                            sn => !serialsToRemove.map(s => s.toUpperCase()).includes(sn.toUpperCase())
                        );
                        if (creationMethod === 'manual') {
                            entry.quantity = Math.max(0, entry.quantity - serialsToRemove.length);
                            remainingQty -= serialsToRemove.length;
                        }
                    }
                }

                if (creationMethod === 'automatic') {
                    const reduceQty = Math.min(remainingQty, entry.quantity);
                    entry.quantity -= reduceQty;
                    remainingQty -= reduceQty;
                }

                if (entry.quantity <= 0) {
                    await StockEntry.findByIdAndDelete(entry._id);
                } else {
                    await entry.save();
                }
            }

            if (creationMethod === 'automatic') {
                await Product.findByIdAndUpdate(item.productRef, {
                    $inc: { quantity: -item.quantity }
                });
            } else if (creationMethod === 'manual' && item.serialNumbers?.length > 0) {
                await Product.findByIdAndUpdate(item.productRef, {
                    $inc: { quantity: -item.serialNumbers.length }
                });
            }
        }
    }
};

// Check if there is enough stock for the requested items
const validateStockAvailability = async (items, creationMethod, extraStock = []) => {
    const warnings = [];
    for (const item of items) {
        if (!item.productRef) continue;

        if (creationMethod === 'automatic') {
            const stockEntries = await StockEntry.find({ product: item.productRef, quantity: { $gt: 0 } });
            let availableQty = stockEntries.reduce((sum, e) => sum + e.quantity, 0);

            // Add extra stock (e.g., stock being restored from an edited invoice)
            const extraForProduct = extraStock
                .filter(es => es.productRef && es.productRef.toString() === item.productRef.toString())
                .reduce((sum, es) => sum + (es.quantity || 0), 0);
            availableQty += extraForProduct;

            if (item.quantity > availableQty) {
                const product = await Product.findById(item.productRef).select('name productId');
                warnings.push({
                    product: product?.name || 'Unknown',
                    productId: product?.productId || '',
                    requested: item.quantity,
                    available: availableQty
                });
            }
        } else if (creationMethod === 'manual' && item.serialNumbers?.length > 0) {
            const entries = await StockEntry.find({ product: item.productRef });
            const allAvailableSerials = new Set(
                entries.flatMap(e => e.serialNumbers.map(s => s.toUpperCase()))
            );

            // Add serials from extra stock (restored from edit)
            for (const es of extraStock) {
                if (es.productRef && es.productRef.toString() === item.productRef.toString() && es.serialNumbers) {
                    es.serialNumbers.forEach(s => allAvailableSerials.add(s.toUpperCase()));
                }
            }

            const requestedSerials = item.serialNumbers.map(s => s.toUpperCase());
            const missingSerials = requestedSerials.filter(s => !allAvailableSerials.has(s));
            if (missingSerials.length > 0) {
                const product = await Product.findById(item.productRef).select('name productId');
                warnings.push({
                    product: product?.name || 'Unknown',
                    productId: product?.productId || '',
                    missingSerials
                });
            }
        }
    }
    return warnings;
};

const validateSerialQuantityMatch = async (items) => {
    const errors = [];

    for (const item of items) {
        const qty = Number(item.quantity) || 0;
        const serials = (item.serialNumbers || []).map(s => String(s).trim()).filter(Boolean);
        const serialCount = serials.length;

        if (!item.productRef) {
            if (serialCount > 0 && serialCount !== qty) {
                errors.push({
                    product: item.manualName || 'Manual item',
                    quantity: qty,
                    serialCount,
                });
            }
            continue;
        }

        const product = await Product.findById(item.productRef).select('name productId');
        const entries = await StockEntry.find({ product: item.productRef });
        const tracksSerials = entries.some(e => e.hasSerialNumbers);

        if (!tracksSerials && serialCount === 0) continue;

        if (serialCount !== qty) {
            errors.push({
                product: product?.name || 'Unknown',
                productId: product?.productId || '',
                quantity: qty,
                serialCount,
            });
        }

        const uniqueSerials = new Set(serials.map(s => s.toUpperCase()));
        if (uniqueSerials.size !== serialCount) {
            errors.push({
                product: product?.name || 'Unknown',
                productId: product?.productId || '',
                message: 'Duplicate serial numbers found in the same item',
            });
        }
    }

    return errors;
};

const calculateWarrantyExpiry = (startDate, warrantyPeriod) => {
    if (!warrantyPeriod || warrantyPeriod.trim() === '') {
        return null;
    }

    const parts = warrantyPeriod.trim().split(/\s+/);
    let duration = 0;
    let unit = 'months';

    for (const part of parts) {
        const num = parseInt(part, 10);
        if (!isNaN(num)) {
            duration = num;
        } else {
            const lower = part.toLowerCase();
            if (lower.startsWith('year') || lower.startsWith('yr')) unit = 'years';
            else if (lower.startsWith('month') || lower.startsWith('mo')) unit = 'months';
            else if (lower.startsWith('week') || lower.startsWith('wk')) unit = 'weeks';
            else if (lower.startsWith('day') || lower.startsWith('d')) unit = 'days';
        }
    }

    if (duration === 0) return null;

    const expiry = new Date(startDate);
    switch (unit) {
        case 'years': expiry.setFullYear(expiry.getFullYear() + duration); break;
        case 'months': expiry.setMonth(expiry.getMonth() + duration); break;
        case 'weeks': expiry.setDate(expiry.getDate() + (duration * 7)); break;
        case 'days': expiry.setDate(expiry.getDate() + duration); break;
    }
    return expiry;
};

exports.getInvoices = async (req, res) => {
    try {
        const invoices = await Invoice.find()
            .populate('clientRef', 'firstName lastName organization clientId telephoneNumber emailAddress address')
            .populate('projectId', 'projectId name location')
            .populate('createdBy', 'firstName lastName')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber')
            .populate('advanceReceipts.receiptRef', 'receiptNumber receiptDate amountReceived paymentMethod receiptType status')
            .sort({ createdAt: -1 })
            .lean();

        const paidMap = await computePaidAmounts(invoices.map(i => i._id));

        const enriched = invoices.map(i => {
            const paidAmount = paidMap[String(i._id)] || 0;
            return {
                ...i,
                paidAmount,
                outstandingBalance: Math.max(0, (i.balanceDue || i.finalTotal || 0) - paidAmount),
            };
        });

        res.status(200).json({ success: true, data: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createInvoice = async (req, res) => {
    try {
        const {
            creationMethod,
            clientRef,
            manualClientDetails,
            projectId,
            paymentMethod,
            creditPeriod,
            deliveryAddress,
            customerPO,
            items,
            subTotal,
            appliedDiscounts,
            discountTotal,
            hasTax,
            appliedTaxes,
            taxTotal,
            finalTotal,
            currency,
            status,
            invoiceDate,
            deliveryNoteRef,
            quotationRef,
            hasAdvancePayment,
            advanceAmount,
            advanceReceipts
        } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one item is required' });
        }

        const serialErrors = await validateSerialQuantityMatch(items);
        if (serialErrors.length > 0) {
            const first = serialErrors[0];
            const detail = first.message
                || `"${first.product}" requires ${first.quantity} serial number(s), but ${first.serialCount} assigned`;
            return res.status(400).json({
                success: false,
                message: `Serial number count must match item quantity. ${detail}`,
                serialErrors,
            });
        }

        // Business rule: every invoice must be linked to a project for warranty tracking
        if (!projectId) {
            return res.status(400).json({ success: false, message: 'A project must be selected for this invoice' });
        }

        // Skip stock validation & deduction for DN-based invoices (stock already deducted on DN delivery)
        const isFromDN = !!deliveryNoteRef;
        const isFromQuotation = !!quotationRef;

        if (isFromQuotation) {
            const quotation = await Quotation.findById(quotationRef);
            if (!quotation) {
                return res.status(404).json({ success: false, message: 'Linked quotation not found' });
            }
            if (['Cancelled', 'Rejected'].includes(quotation.status)) {
                return res.status(403).json({
                    success: false,
                    message: 'Cannot create invoice from a cancelled or rejected quotation.',
                });
            }
            const existingInvoice = await Invoice.findOne({
                quotationRef: quotation._id,
                status: { $ne: 'Cancelled' },
            }).select('invoiceNumber');
            if (existingInvoice) {
                return res.status(400).json({
                    success: false,
                    message: `Quotation is already linked to invoice ${existingInvoice.invoiceNumber}.`,
                });
            }
        }

        if (!isFromDN && (creationMethod === 'automatic' || creationMethod === 'manual')) {
            const stockWarnings = await validateStockAvailability(items, creationMethod);
            if (stockWarnings.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient stock for some items',
                    stockWarnings
                });
            }
        }

        const bizDetails = await BusinessDetails.findOne();
        const prefix = bizDetails?.invoicePrefix || 'INV';
        const digits = bizDetails?.invoiceDigits || 5;

        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const latestInvoice = await Invoice.findOne({
            invoiceNumber: new RegExp('^' + escapedPrefix)
        }).sort({ createdAt: -1 });

        let sequence = 1;
        if (latestInvoice && latestInvoice.invoiceNumber) {
            const suffixStr = latestInvoice.invoiceNumber.substring(prefix.length);
            const num = parseInt(suffixStr, 10);
            if (!isNaN(num)) sequence = num + 1;
        }
        const invoiceNumber = `${prefix}${sequence.toString().padStart(digits, '0')}`;

        const advance = await resolveAdvancePayment(finalTotal, hasAdvancePayment, advanceAmount, advanceReceipts, projectId);
        if (advance.error) {
            return res.status(400).json({ success: false, message: advance.error });
        }

        const initialStatus = resolveInitialStatus(paymentMethod, status, advance.balanceDue);

        const cleanedItems = (items || []).map(i => {
            if (i.productRef === '') i.productRef = undefined;
            return i;
        });

        let enrichedItems = cleanedItems;
        if (!isFromDN) {
            enrichedItems = await enrichItemsWithUnitCost(cleanedItems, creationMethod);
        } else {
            const dn = await DeliveryNote.findById(deliveryNoteRef).select('items');
            enrichedItems = await enrichItemsWithUnitCostFromDN(cleanedItems, dn?.items || []);
        }

        const invoiceData = {
            invoiceNumber,
            creationMethod,
            clientRef: clientRef || undefined,
            manualClientDetails: manualClientDetails || {},
            projectId: projectId || undefined,
            paymentMethod,
            creditPeriod: creditPeriod || { duration: 0, unit: 'days' },
            deliveryAddress: deliveryAddress || '',
            customerPO: customerPO || '',
            items: enrichedItems,
            subTotal,
            appliedDiscounts: appliedDiscounts || [],
            discountTotal: discountTotal || 0,
            hasTax: hasTax || false,
            appliedTaxes: appliedTaxes || [],
            taxTotal: taxTotal || 0,
            finalTotal,
            hasAdvancePayment: advance.hasAdvancePayment,
            advanceAmount: advance.advanceAmount,
            balanceDue: advance.balanceDue,
            advanceReceipts: advance.advanceReceipts,
            currency: currency || 'primary',
            status: initialStatus,
            statusHistory: [{
                status: initialStatus,
                note: 'Initial invoice creation',
                editedBy: req.user._id,
                editedAt: Date.now()
            }],
            invoiceDate: invoiceDate || Date.now(),
            deliveryNoteRef: isFromDN ? deliveryNoteRef : null,
            quotationRef: isFromQuotation ? quotationRef : null,
            createdBy: req.user._id
        };

        const invoice = await Invoice.create(invoiceData);

        await applyAdvanceReceipts(invoice._id, advance.advanceReceipts);

        // Auto-create a payment cash receipt matching the invoice's payment method
        await autoCreatePaymentReceipt(invoice, req.user._id);

        if (!isFromDN) {
            await applyStockDeductions(cleanedItems, creationMethod);
        }

        if (projectId) {
            await Project.findByIdAndUpdate(projectId, {
                $inc: { value: finalTotal }
            });
        }

        const warrantyRecords = [];

        // Skip warranty creation for DN-based invoices (warranties already registered on DN delivery)
        if (!isFromDN) {
            const startDate = invoiceDate ? new Date(invoiceDate) : new Date();

            let projectLocation = '';
            if (projectId) {
                const proj = await Project.findById(projectId).select('location');
                projectLocation = proj?.location || '';
            }

            for (const item of items) {
                if (item.serialNumbers && item.serialNumbers.length > 0 && item.productRef) {
                    const product = await Product.findById(item.productRef);
                    const warrantyPeriod = product?.warrantyPeriod || '';
                    const expiryDate = calculateWarrantyExpiry(startDate, warrantyPeriod);

                    for (const serial of item.serialNumbers) {
                        try {
                            const warranty = await Warranty.create({
                                invoiceRef: invoice._id,
                                clientRef: clientRef || null,
                                projectRef: projectId || null,
                                projectLocation,
                                productRef: item.productRef,
                                serialNumber: serial.toUpperCase(),
                                warrantyPeriod,
                                startDate,
                                expiryDate
                            });
                            warrantyRecords.push(warranty);
                        } catch (err) {
                            console.error(`Warranty creation failed for serial ${serial}:`, err.message);
                        }
                    }
                }
            }
        }

        const populatedInvoice = await Invoice.findById(invoice._id)
            .populate('clientRef')
            .populate('projectId')
            .populate('createdBy', 'firstName lastName')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber');

        res.status(201).json({
            success: true,
            data: populatedInvoice,
            warrantiesCreated: warrantyRecords.length
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getInvoiceById = async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id)
            .populate('clientRef')
            .populate('projectId')
            .populate('createdBy', 'firstName lastName')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber')
            .populate('advanceReceipts.receiptRef', 'receiptNumber receiptDate amountReceived paymentMethod receiptType status');
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        const paidMap = await computePaidAmounts([invoice._id]);
        const paidAmount = paidMap[String(invoice._id)] || 0;
        const doc = invoice.toObject();
        doc.paidAmount = paidAmount;
        doc.outstandingBalance = Math.max(0, (doc.balanceDue || doc.finalTotal || 0) - paidAmount);

        res.status(200).json({ success: true, data: doc });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateInvoice = async (req, res) => {
    try {
        const updatedInvoice = await Invoice.findByIdAndUpdate(req.params.id, req.body, { new: true })
            .populate('clientRef')
            .populate('projectId')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber');
        if (!updatedInvoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
        res.status(200).json({ success: true, data: updatedInvoice });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateInvoiceStatus = async (req, res) => {
    try {
        const { status, note } = req.body;
        if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        if (invoice.paymentMethod === 'cash') {
            return res.status(400).json({ success: false, message: 'Cash invoices are permanently marked as Paid' });
        }

        invoice.status = status;
        invoice.statusHistory.push({
            status,
            note: note || '',
            editedBy: req.user._id,
            editedAt: Date.now()
        });

        await invoice.save();

        const updatedInvoice = await Invoice.findById(invoice._id)
            .populate('clientRef')
            .populate('projectId')
            .populate('createdBy', 'firstName lastName')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber');

        res.status(200).json({ success: true, data: updatedInvoice });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.editInvoice = async (req, res) => {
    try {
        const originalInvoice = await Invoice.findById(req.params.id);
        if (!originalInvoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        if (originalInvoice.status === 'Cancelled') {
            return res.status(400).json({ success: false, message: 'Cannot edit a cancelled invoice' });
        }

        if (!isWithinEditWindow(originalInvoice.createdAt)) {
            return res.status(403).json({ success: false, message: 'Invoice can only be edited within 30 days of creation' });
        }

        const {
            creationMethod,
            clientRef,
            manualClientDetails,
            projectId,
            paymentMethod,
            creditPeriod,
            deliveryAddress,
            customerPO,
            items,
            subTotal,
            appliedDiscounts,
            discountTotal,
            hasTax,
            appliedTaxes,
            taxTotal,
            finalTotal,
            currency,
            status,
            invoiceDate,
            editNote,
            hasAdvancePayment,
            advanceAmount,
            advanceReceipts
        } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one item is required' });
        }
        if (!projectId) {
            return res.status(400).json({ success: false, message: 'A project must be selected' });
        }

        const serialErrors = await validateSerialQuantityMatch(items);
        if (serialErrors.length > 0) {
            const first = serialErrors[0];
            const detail = first.message
                || `"${first.product}" requires ${first.quantity} serial number(s), but ${first.serialCount} assigned`;
            return res.status(400).json({
                success: false,
                message: `Serial number count must match item quantity. ${detail}`,
                serialErrors,
            });
        }

        const isFromDN = !!originalInvoice.deliveryNoteRef;
        const method = creationMethod || originalInvoice.creationMethod;

        // Skip stock validation & reversal for DN-based invoices (stock already handled at DN delivery)
        if (!isFromDN) {
            const stockWarnings = await validateStockAvailability(items, method, originalInvoice.items);
            if (stockWarnings.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient stock for some items',
                    stockWarnings
                });
            }

            // 1. Reverse stock effects of the original invoice
            await reverseInvoiceStock(originalInvoice);

            // 2. Delete old warranty records linked to original invoice
            await Warranty.deleteMany({ invoiceRef: originalInvoice._id });
        }

        // 3. Reverse project value contribution
        await Project.findByIdAndUpdate(originalInvoice.projectId, {
            $inc: { value: -originalInvoice.finalTotal }
        });

        // 4. Cancel the original invoice
        originalInvoice.status = 'Cancelled';
        originalInvoice.cancelledBy = req.user._id;
        originalInvoice.cancellationNote = editNote || `Replaced by edited invoice`;
        originalInvoice.statusHistory.push({
            status: 'Cancelled',
            note: editNote || 'Invoice superseded by edit',
            editedBy: req.user._id,
            editedAt: Date.now()
        });
        await originalInvoice.save();

        // Release advance cash receipts attached to the original invoice so they can be reused
        await releaseAdvanceReceipts(originalInvoice._id);

        // 5. Generate new invoice number
        const bizDetails = await BusinessDetails.findOne();
        const prefix = bizDetails?.invoicePrefix || 'INV';
        const digits = bizDetails?.invoiceDigits || 5;

        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const latestInvoice = await Invoice.findOne({
            invoiceNumber: new RegExp('^' + escapedPrefix)
        }).sort({ createdAt: -1 });

        let sequence = 1;
        if (latestInvoice && latestInvoice.invoiceNumber) {
            const suffixStr = latestInvoice.invoiceNumber.substring(prefix.length);
            const num = parseInt(suffixStr, 10);
            if (!isNaN(num)) sequence = num + 1;
        }
        const newInvoiceNumber = `${prefix}${sequence.toString().padStart(digits, '0')}`;

        const advance = await resolveAdvancePayment(finalTotal, hasAdvancePayment, advanceAmount, advanceReceipts, projectId);
        if (advance.error) {
            return res.status(400).json({ success: false, message: advance.error });
        }

        const initialStatus = resolveInitialStatus(paymentMethod, status, advance.balanceDue);

        let enrichedItems = items;
        if (!isFromDN) {
            enrichedItems = await enrichItemsWithUnitCost(items, method);
        } else if (originalInvoice.deliveryNoteRef) {
            const dn = await DeliveryNote.findById(originalInvoice.deliveryNoteRef).select('items');
            enrichedItems = await enrichItemsWithUnitCostFromDN(items, dn?.items || []);
        }

        const newHistory = [...originalInvoice.statusHistory, {
            status: initialStatus,
            note: `Created as edit of ${originalInvoice.invoiceNumber}`,
            editedBy: req.user._id,
            editedAt: Date.now()
        }];

        // 6. Create the new invoice
        const newInvoice = await Invoice.create({
            invoiceNumber: newInvoiceNumber,
            creationMethod: creationMethod || originalInvoice.creationMethod,
            clientRef: clientRef || undefined,
            manualClientDetails: manualClientDetails || {},
            projectId: projectId || undefined,
            paymentMethod,
            creditPeriod: creditPeriod || { duration: 0, unit: 'days' },
            deliveryAddress: deliveryAddress || '',
            customerPO: customerPO || '',
            items: enrichedItems,
            subTotal,
            appliedDiscounts: appliedDiscounts || [],
            discountTotal: discountTotal || 0,
            hasTax: hasTax || false,
            appliedTaxes: appliedTaxes || [],
            taxTotal: taxTotal || 0,
            finalTotal,
            hasAdvancePayment: advance.hasAdvancePayment,
            advanceAmount: advance.advanceAmount,
            balanceDue: advance.balanceDue,
            advanceReceipts: advance.advanceReceipts,
            currency: currency || 'primary',
            status: initialStatus,
            statusHistory: newHistory,
            originalInvoiceRef: originalInvoice._id,
            deliveryNoteRef: isFromDN ? originalInvoice.deliveryNoteRef : null,
            invoiceDate: invoiceDate || Date.now(),
            createdBy: req.user._id
        });

        // 7. Apply new stock deductions (skip for DN-based invoices)
        if (!isFromDN) {
            await applyStockDeductions(items, method);
        }

        // Apply advance cash receipts to the replacement invoice
        await applyAdvanceReceipts(newInvoice._id, advance.advanceReceipts);

        // Void the original invoice's auto-generated receipt and issue a new one
        await voidAutoReceiptForInvoice(originalInvoice._id, req.user._id, `Replaced by edited invoice ${newInvoiceNumber}`);
        await autoCreatePaymentReceipt(newInvoice, req.user._id);

        // 8. Update project value
        if (projectId) {
            await Project.findByIdAndUpdate(projectId, { $inc: { value: finalTotal } });
        }

        // 9. Create new warranty records (skip for DN-based — already registered on DN delivery)
        if (!isFromDN) {
            const startDate = invoiceDate ? new Date(invoiceDate) : new Date();
            let projectLocation = '';
            if (projectId) {
                const proj = await Project.findById(projectId).select('location');
                projectLocation = proj?.location || '';
            }

            for (const item of items) {
                if (item.serialNumbers && item.serialNumbers.length > 0 && item.productRef) {
                    const product = await Product.findById(item.productRef);
                    const warrantyPeriod = product?.warrantyPeriod || '';
                    const expiryDate = calculateWarrantyExpiry(startDate, warrantyPeriod);
                    for (const serial of item.serialNumbers) {
                        try {
                            await Warranty.create({
                                invoiceRef: newInvoice._id,
                                clientRef: clientRef || null,
                                projectRef: projectId || null,
                                projectLocation,
                                productRef: item.productRef,
                                serialNumber: serial.toUpperCase(),
                                warrantyPeriod,
                                startDate,
                                expiryDate
                            });
                        } catch (err) {
                            console.error(`Warranty creation failed for serial ${serial}:`, err.message);
                        }
                    }
                }
            }
        }

        const populatedInvoice = await Invoice.findById(newInvoice._id)
            .populate('clientRef')
            .populate('projectId')
            .populate('createdBy', 'firstName lastName')
            .populate('statusHistory.editedBy', 'firstName lastName')
            .populate('items.productRef', 'name productId warrantyPeriod')
            .populate('deliveryNoteRef', 'deliveryNoteNumber');

        res.status(201).json({
            success: true,
            data: populatedInvoice,
            cancelledInvoiceNumber: originalInvoice.invoiceNumber
        });
    } catch (error) {
        console.error('editInvoice error:', error);
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteInvoice = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'Deletion reason is required' });
        }

        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        if (!isWithinEditWindow(invoice.createdAt)) {
            return res.status(403).json({ success: false, message: 'Invoice can only be deleted within 30 days of creation' });
        }

        const trimmedReason = String(reason).trim();

        // Skip stock reversal/warranty deletion for DN-based invoices (stock handled at DN level)
        const isFromDN = !!invoice.deliveryNoteRef;
        if (!isFromDN && invoice.status !== 'Cancelled') {
            await reverseInvoiceStock(invoice);
            await Warranty.deleteMany({ invoiceRef: invoice._id });
        }

        // Soft delete the invoice by setting status to Cancelled
        invoice.status = 'Cancelled';
        invoice.cancelledBy = req.user._id;
        invoice.cancellationNote = trimmedReason;
        invoice.statusHistory.push({
            status: 'Cancelled',
            note: `Invoice deleted. Reason: ${trimmedReason}`,
            editedBy: req.user._id,
            editedAt: Date.now()
        });
        await invoice.save();

        // Release advance cash receipts applied to this invoice
        await releaseAdvanceReceipts(invoice._id);

        // Void auto-generated payment receipt for this invoice
        await voidAutoReceiptForInvoice(invoice._id, req.user._id, 'Linked invoice cancelled');

        // Reverse the project revenue contribution
        if (invoice.projectId) {
            await Project.findByIdAndUpdate(invoice.projectId, {
                $inc: { value: -(invoice.finalTotal || 0) }
            });
        }

        await InvoiceDeleteRequest.deleteMany({ invoice: req.params.id });

        res.status(200).json({ success: true, message: 'Invoice deleted and stock restored successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getInvoiceStats = async (req, res) => {
    try {
        const { period } = req.query;
        const now = new Date();
        let start, end, dateFormat;

        switch (period) {
            case 'daily':
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                dateFormat = '%Y-%m-%d';
                break;
            case 'monthly':
                start = new Date(now.getFullYear(), now.getMonth(), 1);
                end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                dateFormat = '%Y-%m-%d';
                break;
            default:
                start = new Date(now.getFullYear(), 0, 1);
                end = new Date(now.getFullYear() + 1, 0, 1);
                dateFormat = '%Y-%m';
                break;
        }

        const dateMatch = { createdAt: { $gte: start, $lt: end } };
        const activeMatch = { ...dateMatch, status: { $ne: 'Cancelled' } };

        const totalInvoices = await Invoice.countDocuments(activeMatch);
        const cancelledCount = await Invoice.countDocuments({ ...dateMatch, status: 'Cancelled' });

        const totalSales = await Invoice.aggregate([
            { $match: activeMatch },
            { $group: { _id: null, total: { $sum: '$finalTotal' } } }
        ]);
        const totalReturns = await SalesReturnNote.aggregate([
            { $match: { createdAt: { $gte: start, $lt: end } } },
            { $group: { _id: null, total: { $sum: '$returnAmount' } } },
        ]);

        const paymentMethodBreakdown = await Invoice.aggregate([
            { $match: activeMatch },
            { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$finalTotal' } } }
        ]);

        const statusBreakdown = await Invoice.aggregate([
            { $match: dateMatch },
            { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$finalTotal' } } }
        ]);

        const salesOverTime = await Invoice.aggregate([
            { $match: activeMatch },
            {
                $group: {
                    _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
                    total: { $sum: '$finalTotal' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        const recentInvoices = await Invoice.find(activeMatch)
            .populate('clientRef', 'firstName lastName')
            .sort({ createdAt: -1 })
            .limit(10);

        const profitAgg = await Invoice.aggregate([
            { $match: activeMatch },
            {
                $addFields: {
                    itemCost: {
                        $sum: {
                            $map: {
                                input: { $ifNull: ['$items', []] },
                                as: 'item',
                                in: {
                                    $multiply: [
                                        { $ifNull: ['$$item.unitCost', 0] },
                                        { $ifNull: ['$$item.quantity', 0] },
                                    ],
                                },
                            },
                        },
                    },
                    netRevenue: {
                        $subtract: [
                            { $ifNull: ['$subTotal', 0] },
                            { $ifNull: ['$discountTotal', 0] },
                        ],
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    totalCost: { $sum: '$itemCost' },
                    totalRevenue: { $sum: '$netRevenue' },
                    totalProfit: { $sum: { $subtract: ['$netRevenue', '$itemCost'] } },
                },
            },
        ]);

        const profitData = profitAgg[0] || { totalCost: 0, totalRevenue: 0, totalProfit: 0 };
        const profitMargin = profitData.totalRevenue > 0
            ? Math.round((profitData.totalProfit / profitData.totalRevenue) * 1000) / 10
            : 0;

        res.status(200).json({
            success: true,
            data: {
                period: period || 'yearly',
                dateRange: { start, end },
                totalInvoices,
                cancelledCount,
                totalSales: totalSales[0]?.total || 0,
                totalReturns: totalReturns[0]?.total || 0,
                netSales: (totalSales[0]?.total || 0) - (totalReturns[0]?.total || 0),
                totalCost: profitData.totalCost,
                totalRevenue: profitData.totalRevenue,
                totalProfit: profitData.totalProfit,
                profitMargin,
                paymentMethodBreakdown,
                statusBreakdown,
                salesOverTime,
                recentInvoices
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.requestDelete = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'Reason for deletion is required' });

        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        if (!isWithinEditWindow(invoice.createdAt)) {
            return res.status(403).json({ success: false, message: 'Delete requests can only be raised within 30 days of invoice creation' });
        }

        const request = await InvoiceDeleteRequest.create({
            invoice: req.params.id,
            requestedBy: req.user._id,
            reason
        });

        const admins = await User.find({ role: { $in: ['admin', 'root'] } });
        for (const admin of admins) {
            await createNotification(
                admin._id,
                'delete_request',
                'Deletion Request',
                `${req.user.firstName} ${req.user.lastName} requested deletion of invoice ${invoice.invoiceNumber}. Reason: ${reason}`,
                request._id
            );
        }

        res.status(201).json({ success: true, message: 'Deletion request transmitted to Security.', data: request });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getDeleteRequests = async (req, res) => {
    try {
        const requests = await InvoiceDeleteRequest.find({ status: 'Pending' })
            .populate('requestedBy', 'firstName lastName')
            .populate('invoice');
        res.status(200).json({ success: true, data: requests });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.approveDeleteRequest = async (req, res) => {
    try {
        const request = await InvoiceDeleteRequest.findById(req.params.requestId).populate('requestedBy');
        if (!request || request.status !== 'Pending') {
            return res.status(404).json({ success: false, message: 'Pending request not isolated' });
        }

        const invoice = await Invoice.findById(request.invoice);
        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        // Skip stock reversal for DN-based invoices (stock handled at DN level)
        const isFromDN = !!invoice.deliveryNoteRef;
        if (!isFromDN && invoice.status !== 'Cancelled') {
            await reverseInvoiceStock(invoice);
            await Warranty.deleteMany({ invoiceRef: invoice._id });
        }

        // Soft delete the invoice by setting status to Cancelled
        invoice.status = 'Cancelled';
        invoice.cancelledBy = req.user._id;
        invoice.cancellationNote = request.reason;
        invoice.statusHistory.push({
            status: 'Cancelled',
            note: `Invoice deleted via approved request. Reason: ${request.reason}`,
            editedBy: req.user._id,
            editedAt: Date.now()
        });
        await invoice.save();

        // Release advance cash receipts applied to this invoice
        await releaseAdvanceReceipts(invoice._id);

        // Void auto-generated payment receipt for this invoice
        await voidAutoReceiptForInvoice(invoice._id, req.user._id, 'Linked invoice cancelled');

        // Reverse the project revenue contribution
        if (invoice.projectId) {
            await Project.findByIdAndUpdate(invoice.projectId, {
                $inc: { value: -(invoice.finalTotal || 0) }
            });
        }

        request.status = 'Approved';
        request.reviewedBy = req.user._id;
        request.reviewedAt = Date.now();
        await request.save();

        await createNotification(
            request.requestedBy._id,
            'approval',
            'Deletion Approved',
            `Your deletion request for invoice ${invoice?.invoiceNumber || 'N/A'} has been approved by ${req.user.firstName} ${req.user.lastName}.`
        );

        res.status(200).json({ success: true, message: 'Invoice securely deleted per request.' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.rejectDeleteRequest = async (req, res) => {
    try {
        const request = await InvoiceDeleteRequest.findById(req.params.requestId).populate('requestedBy');
        if (!request || request.status !== 'Pending') {
            return res.status(404).json({ success: false, message: 'Request not isolated' });
        }

        const invoice = await Invoice.findById(request.invoice);

        request.status = 'Rejected';
        request.reviewedBy = req.user._id;
        request.reviewedAt = Date.now();
        await request.save();

        await createNotification(
            request.requestedBy._id,
            'rejection',
            'Deletion Rejected',
            `Your deletion request for invoice ${invoice?.invoiceNumber || 'N/A'} has been rejected by ${req.user.firstName} ${req.user.lastName}.`
        );

        res.status(200).json({ success: true, message: 'Invoice deletion averted.' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
