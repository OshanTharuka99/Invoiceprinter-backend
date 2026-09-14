const CashReceipt = require('../models/CashReceipt');
const BusinessDetails = require('../models/BusinessDetails');
require('../models/Invoice');
require('../models/Quotation');
require('../models/Project');
require('../models/Client');
require('../models/User');

const RECEIPT_PREFIX = 'CR';
const RECEIPT_DIGITS = 5;

const generateReceiptNumber = async () => {
    const bizDetails = await BusinessDetails.findOne();
    const prefix = bizDetails?.cashReceiptPrefix || RECEIPT_PREFIX;
    const digits = bizDetails?.cashReceiptDigits || RECEIPT_DIGITS;

    const escapedPrefix = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const latest = await CashReceipt.findOne({
        receiptNumber: new RegExp('^' + escapedPrefix)
    }).sort({ createdAt: -1 });

    let sequence = 1;
    if (latest && latest.receiptNumber) {
        const suffixStr = latest.receiptNumber.substring(String(prefix).length);
        const num = parseInt(suffixStr, 10);
        if (!isNaN(num)) sequence = num + 1;
    }
    return `${prefix}${String(sequence).padStart(digits, '0')}`;
};

const getClientName = (r) => {
    if (r.clientRef) {
        return [r.clientRef.firstName, r.clientRef.lastName].filter(Boolean).join(' ') || r.clientRef.organization || 'Walk-in Customer';
    }
    if (r.manualClientDetails) {
        return r.manualClientDetails.name || r.manualClientDetails.organization || 'Walk-in Customer';
    }
    return 'Walk-in Customer';
};

exports.getCashReceipts = async (req, res) => {
    try {
        const { status, search } = req.query;
        const filter = {};
        if (status && ['issued', 'void'].includes(status)) filter.status = status;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [receipts, todayAgg, monthAgg, voidedCount] = await Promise.all([
CashReceipt.find(filter)
                .populate('clientRef', 'firstName lastName organization clientId telephoneNumber address clientType')
                .populate('projectRef', 'name projectId')
                .populate('quotationRef', 'quotationId')
                .populate('invoiceRef', 'invoiceNumber')
                .populate('receivedBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .lean(),
            CashReceipt.aggregate([
                { $match: { status: 'issued', receiptDate: { $gte: startOfToday } } },
                { $group: { _id: null, total: { $sum: '$amountReceived' }, count: { $sum: 1 } } }
            ]),
            CashReceipt.aggregate([
                { $match: { status: 'issued', receiptDate: { $gte: startOfMonth } } },
                { $group: { _id: null, total: { $sum: '$amountReceived' }, count: { $sum: 1 } } }
            ]),
            CashReceipt.countDocuments({ status: 'void' })
        ]);

        let list = receipts;
        if (search && String(search).trim()) {
            const term = String(search).trim().toLowerCase();
            list = list.filter(r =>
                String(r.receiptNumber || '').toLowerCase().includes(term) ||
                getClientName(r).toLowerCase().includes(term) ||
                r.manualClientDetails?.organization?.toLowerCase().includes(term)
            );
        }

        res.status(200).json({
            success: true,
            stats: {
                todayTotal: todayAgg[0]?.total || 0,
                todayCount: todayAgg[0]?.count || 0,
                monthTotal: monthAgg[0]?.total || 0,
                monthCount: monthAgg[0]?.count || 0,
                voidedCount
            },
            data: list
        });
    } catch (error) {
        console.error('getCashReceipts error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getCashReceiptById = async (req, res) => {
    try {
        const receipt = await CashReceipt.findById(req.params.id)
            .populate('clientRef')
            .populate('projectRef', 'name projectId')
            .populate('quotationRef', 'quotationId clientRef')
            .populate('invoiceRef', 'invoiceNumber')
            .populate('receivedBy', 'firstName lastName')
            .populate('voidedBy', 'firstName lastName');
        if (!receipt) return res.status(404).json({ success: false, message: 'Cash receipt not found' });
        res.status(200).json({ success: true, data: receipt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createCashReceipt = async (req, res) => {
    try {
        const {
            receiptDate,
            clientRef,
            manualClientDetails,
            amountReceived,
            paymentMethod,
            projectRef,
            quotationRef,
            invoiceRef,
            chequeNumber,
            description
        } = req.body;

        const amount = Number(amountReceived);
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount received must be greater than zero' });
        }

        const manual = manualClientDetails || {};
        const hasClient = !!clientRef || !!(manual.name || manual.organization);
        if (!hasClient) {
            return res.status(400).json({ success: false, message: 'Please select a client or provide a manual client name' });
        }

        const receiptNumber = await generateReceiptNumber();

        const receipt = await CashReceipt.create({
            receiptNumber,
            receiptDate: receiptDate || Date.now(),
            clientRef: clientRef || null,
            manualClientDetails: {
                organization: manual.organization || '',
                name: manual.name || '',
                telephoneNumber: manual.telephoneNumber || '',
                address: manual.address || ''
            },
            amountReceived: amount,
            paymentMethod: paymentMethod || 'cash',
            chequeNumber: paymentMethod === 'cheque' ? (chequeNumber || '') : '',
            projectRef: projectRef || null,
            quotationRef: quotationRef || null,
            invoiceRef: invoiceRef || null,
            description: description || '',
            receivedBy: req.user._id,
            status: 'issued'
        });

        const populated = await CashReceipt.findById(receipt._id)
            .populate('clientRef', 'firstName lastName organization clientId')
            .populate('receivedBy', 'firstName lastName');

        res.status(201).json({ success: true, data: populated });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.voidCashReceipt = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'Void reason is required' });
        }

        const receipt = await CashReceipt.findById(req.params.id);
        if (!receipt) return res.status(404).json({ success: false, message: 'Cash receipt not found' });
        if (receipt.status === 'void') {
            return res.status(400).json({ success: false, message: 'Cash receipt is already void' });
        }

        receipt.status = 'void';
        receipt.voidNote = String(reason).trim();
        receipt.voidedBy = req.user._id;
        await receipt.save();

        res.status(200).json({ success: true, message: 'Cash receipt voided successfully', data: receipt });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};