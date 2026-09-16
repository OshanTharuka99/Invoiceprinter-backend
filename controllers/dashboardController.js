const User = require('../models/User');
const Client = require('../models/Client');
const Product = require('../models/Product');
const Project = require('../models/Project');
const Supplier = require('../models/Supplier');
const Quotation = require('../models/Quotation');
const Warranty = require('../models/Warranty');
const Invoice = require('../models/Invoice');
const CashReceipt = require('../models/CashReceipt');
const SalesReturnNote = require('../models/SalesReturnNote');
const PurchaseOrder = require('../models/PurchaseOrder');
const RmaJob = require('../models/RmaJob');
const BusinessDetails = require('../models/BusinessDetails');

const emptyRmaByStatus = () => ({
    Open: 0,
    'In Progress': 0,
    'Awaiting Supplier': 0,
    Resolved: 0,
    Closed: 0,
    Cancelled: 0,
});

const addCreditDuration = (invoiceDate, creditPeriod) => {
    const d = new Date(invoiceDate);
    const duration = Number(creditPeriod?.duration) || 0;
    const unit = creditPeriod?.unit || 'days';
    if (unit === 'weeks') d.setDate(d.getDate() + duration * 7);
    else if (unit === 'months') d.setMonth(d.getMonth() + duration);
    else d.setDate(d.getDate() + duration);
    return d;
};

const buildExpiredCreditProjects = async (now) => {
    const creditInvoices = await Invoice.find({
        paymentMethod: 'credit',
        status: { $ne: 'Cancelled' },
        projectId: { $ne: null },
    })
        .select('_id projectId finalTotal invoiceDate creditPeriod')
        .populate({
            path: 'projectId',
            select: 'name client',
            populate: { path: 'client', select: 'firstName lastName organization telephoneNumber' },
        })
        .lean();

    const expired = [];
    for (const inv of creditInvoices) {
        const due = addCreditDuration(inv.invoiceDate, inv.creditPeriod);
        if (due.getTime() < now.getTime()) expired.push({ inv, due });
    }
    if (expired.length === 0) return [];

    const paidAgg = await CashReceipt.aggregate([
        { $match: { invoiceRef: { $in: expired.map(r => r.inv._id) }, status: 'issued', receiptType: 'payment' } },
        { $group: { _id: '$invoiceRef', total: { $sum: '$amountReceived' } } },
    ]);
    const paidMap = {};
    paidAgg.forEach((a) => { paidMap[String(a._id)] = a.total; });

    const byProject = {};
    expired.forEach(({ inv, due }) => {
        const outstanding = (inv.finalTotal || 0) - (paidMap[String(inv._id)] || 0);
        if (outstanding <= 0) return;
        const proj = inv.projectId;
        const key = String(proj?._id || inv.projectId);
        const entry = byProject[key] || (byProject[key] = {
            projectId: key,
            projectName: proj?.name || 'Unknown Project',
            clientName: proj?.client ? `${proj.client.firstName ?? ''} ${proj.client.lastName ?? ''}`.trim() : '',
            phone: proj?.client?.telephoneNumber || '',
            creditValue: 0,
            daysOverdue: 0,
        });
        entry.creditValue += outstanding;
        const days = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
        entry.daysOverdue = Math.max(entry.daysOverdue, days);
    });

    return Object.values(byProject)
        .map((e) => ({ ...e, creditValue: Math.round(e.creditValue * 100) / 100 }))
        .sort((a, b) => b.daysOverdue - a.daysOverdue || b.creditValue - a.creditValue);
};

const tallyRma = (rows) => {
    const map = emptyRmaByStatus();
    (rows || []).forEach((row) => {
        if (row._id && map[row._id] !== undefined) map[row._id] = row.count || 0;
    });
    return map;
};

const profitPipelineStages = [
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
];

const buildInvoicePeriodStats = async (period) => {
    const now = new Date();
    let start;
    let end;
    let dateFormat;

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

    const [
        totalInvoices,
        cancelledCount,
        totalSales,
        totalReturns,
        paymentMethodBreakdown,
        statusBreakdown,
        salesOverTime,
        recentInvoices,
        profitAgg,
        receiptBreakdown,
        creditInvoicedAgg,
        creditPaidAgg,
        expiredCreditProjects,
    ] = await Promise.all([
        Invoice.countDocuments(activeMatch),
        Invoice.countDocuments({ ...dateMatch, status: 'Cancelled' }),
        Invoice.aggregate([
            { $match: activeMatch },
            { $group: { _id: null, total: { $sum: '$finalTotal' } } },
        ]),
        SalesReturnNote.aggregate([
            { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'Cancelled' } } },
            { $group: { _id: null, total: { $sum: '$returnAmount' } } },
        ]),
        Invoice.aggregate([
            { $match: activeMatch },
            { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$finalTotal' } } },
        ]),
        Invoice.aggregate([
            { $match: dateMatch },
            { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$finalTotal' } } },
        ]),
        Invoice.aggregate([
            { $match: activeMatch },
            {
                $group: {
                    _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
                    total: { $sum: '$finalTotal' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]),
        Invoice.find(activeMatch)
            .select('invoiceNumber invoiceDate finalTotal status clientRef createdAt paymentMethod')
            .populate('clientRef', 'firstName lastName organization')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        Invoice.aggregate([{ $match: activeMatch }, ...profitPipelineStages]),
        CashReceipt.aggregate([
            { $match: { status: 'issued', receiptDate: { $gte: start, $lt: end } } },
            { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$amountReceived' } } },
        ]),
        Invoice.aggregate([
            { $match: { paymentMethod: 'credit', status: { $ne: 'Cancelled' } } },
            { $group: { _id: null, total: { $sum: '$finalTotal' } } },
        ]),
        CashReceipt.aggregate([
            {
                $match: {
                    status: 'issued',
                    $or: [
                        { invoiceRef: { $ne: null } },
                        { appliedToInvoice: { $ne: null } },
                    ],
                },
            },
            { $lookup: { from: 'invoices', localField: 'invoiceRef', foreignField: '_id', as: 'invs1' } },
            { $lookup: { from: 'invoices', localField: 'appliedToInvoice', foreignField: '_id', as: 'invs2' } },
            { $project: { amountReceived: 1, invs: { $setUnion: ['$invs1', '$invs2'] } } },
            { $unwind: { path: '$invs', preserveNullAndEmptyArrays: false } },
            { $match: { 'invs.paymentMethod': 'credit', 'invs.status': { $ne: 'Cancelled' } } },
            { $group: { _id: null, total: { $sum: '$amountReceived' } } },
        ]),
        buildExpiredCreditProjects(now),
    ]);

    const profitData = profitAgg[0] || { totalCost: 0, totalRevenue: 0, totalProfit: 0 };
    const profitMargin = profitData.totalRevenue > 0
        ? Math.round((profitData.totalProfit / profitData.totalRevenue) * 1000) / 10
        : 0;

    const creditValue = (creditInvoicedAgg[0]?.total || 0) - (creditPaidAgg[0]?.total || 0);

    return {
        period: period || 'yearly',
        dateRange: { start, end },
        totalInvoices,
        cancelledCount,
        totalSales: totalSales[0]?.total || 0,
        totalReturns: totalReturns[0]?.total || 0,
        paymentMethodBreakdown,
        receiptBreakdown,
        receiptTotal: receiptBreakdown.reduce((s, r) => s + (r.total || 0), 0),
        receiptCount: receiptBreakdown.reduce((s, r) => s + (r.count || 0), 0),
        creditValue,
        statusBreakdown,
        salesOverTime,
        recentInvoices,
        expiredCreditProjects,
        totalCost: profitData.totalCost || 0,
        totalProfit: profitData.totalProfit || 0,
        profitMargin,
    };
};

const buildUserWorkspace = async (userId) => {
    const myMatch = { createdBy: userId };
    const activeMy = { ...myMatch, status: { $ne: 'Cancelled' } };

    const [
        myInvoices,
        statusBreakdown,
        revenueByStatus,
        profitAll,
        profitPaid,
        myQuotationsCount,
        quotationAgg,
        myQuotations,
        poAgg,
        myPOs,
        rmaAgg,
        myInvoiceCount,
    ] = await Promise.all([
        Invoice.find(myMatch)
            .select('invoiceNumber invoiceDate finalTotal status currency clientRef manualClientDetails createdAt paymentMethod')
            .populate('clientRef', 'firstName lastName organization')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean(),
        Invoice.aggregate([
            { $match: myMatch },
            { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$finalTotal' } } },
        ]),
        Invoice.aggregate([
            { $match: activeMy },
            { $group: { _id: '$status', total: { $sum: '$finalTotal' } } },
        ]),
        Invoice.aggregate([{ $match: activeMy }, ...profitPipelineStages]),
        Invoice.aggregate([{ $match: { ...myMatch, status: 'Paid' } }, ...profitPipelineStages]),
        Quotation.countDocuments({ createdBy: userId, status: { $ne: 'Cancelled' } }),
        Quotation.aggregate([
            { $match: { createdBy: userId } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Quotation.find({ createdBy: userId })
            .select('quotationId status createdAt finalTotal currency clientRef manualClientDetails')
            .populate('clientRef', 'firstName lastName organization')
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
        PurchaseOrder.aggregate([
            { $match: { createdBy: userId } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        PurchaseOrder.find({ createdBy: userId })
            .select('poNumber status poDate finalTotal currency supplierRef')
            .populate('supplierRef', 'name firstName lastName')
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
        RmaJob.aggregate([
            {
                $match: {
                    $or: [{ createdBy: userId }, { assignees: userId }],
                },
            },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Invoice.countDocuments(myMatch),
    ]);

    const paidTotal = (revenueByStatus.find((r) => r._id === 'Paid') || {}).total || 0;
    const unpaidTotal = (revenueByStatus.find((r) => r._id === 'Unpaid') || {}).total || 0;
    const pendingTotal = (revenueByStatus.find((r) => r._id === 'Pending') || {}).total || 0;

    const profit = profitAll[0] || { totalCost: 0, totalRevenue: 0, totalProfit: 0 };
    const paidProfit = profitPaid[0] || { totalCost: 0, totalRevenue: 0, totalProfit: 0 };
    const profitMargin = profit.totalRevenue > 0
        ? Math.round((profit.totalProfit / profit.totalRevenue) * 1000) / 10
        : 0;

    const poByStatus = {};
    let poTotal = 0;
    (poAgg || []).forEach((row) => {
        poByStatus[row._id || 'Unknown'] = row.count || 0;
        poTotal += row.count || 0;
    });

    const quotationByStatus = {};
    let quotationTotal = 0;
    (quotationAgg || []).forEach((row) => {
        quotationByStatus[row._id || 'Unknown'] = row.count || 0;
        quotationTotal += row.count || 0;
    });

    return {
        myInvoices,
        myInvoiceCount,
        statusBreakdown,
        totals: {
            paid: paidTotal,
            unpaid: unpaidTotal,
            pending: pendingTotal,
            billed: paidTotal + unpaidTotal + pendingTotal,
        },
        profit: {
            totalCost: profit.totalCost || 0,
            totalRevenue: profit.totalRevenue || 0,
            totalProfit: profit.totalProfit || 0,
            profitMargin,
            paidProfit: paidProfit.totalProfit || 0,
        },
        myQuotations: myQuotationsCount,
        quotations: {
            total: quotationTotal,
            byStatus: quotationByStatus,
            recent: myQuotations,
        },
        purchaseOrders: {
            total: poTotal,
            byStatus: poByStatus,
            recent: myPOs,
        },
        myRmaByStatus: tallyRma(rmaAgg),
    };
};

exports.getDashboardStats = async (req, res) => {
    try {
        const period = req.query.period || 'yearly';
        const now = new Date();
        const userId = req.user._id;
        const isUser = req.user.role === 'user';

        const [
            users,
            clients,
            products,
            projects,
            suppliers,
            quotations,
            warrantyTotal,
            warrantyActive,
            warrantyExpired,
            invoiceStats,
            rmaAgg,
            business,
            userWorkspace,
        ] = await Promise.all([
            User.countDocuments(),
            Client.countDocuments(),
            Product.countDocuments(),
            Project.countDocuments(),
            Supplier.countDocuments(),
            Quotation.countDocuments({ status: { $ne: 'Cancelled' } }),
            Warranty.countDocuments(),
            Warranty.countDocuments({ status: 'active', $or: [{ expiryDate: null }, { expiryDate: { $gte: now } }] }),
            Warranty.countDocuments({
                $or: [
                    { status: 'expired' },
                    { status: 'active', expiryDate: { $lt: now } },
                ],
            }),
            isUser ? Promise.resolve(null) : buildInvoicePeriodStats(period),
            RmaJob.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
            BusinessDetails.findOne().select('businessName primaryCurrency logo quotationLogo').lean(),
            isUser ? buildUserWorkspace(userId) : Promise.resolve(null),
        ]);

        res.status(200).json({
            success: true,
            data: {
                counts: {
                    users,
                    clients,
                    products,
                    projects,
                    suppliers,
                    quotations,
                    warranties: {
                        total: warrantyTotal,
                        active: warrantyActive,
                        expired: warrantyExpired,
                    },
                    myInvoices: userWorkspace?.myInvoiceCount ?? null,
                    myQuotations: userWorkspace?.myQuotations ?? null,
                    myPurchaseOrders: userWorkspace?.purchaseOrders?.total ?? null,
                },
                invoices: invoiceStats,
                rmaByStatus: tallyRma(rmaAgg),
                business: business || null,
                userWorkspace,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
