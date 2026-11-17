const StockEntry = require('../models/StockEntry');
const User = require('../models/User');
const Notification = require('../models/Notification');

const DAY_MS = 86400000;
const WARNING_DAYS = 7;

const formatDate = (date) => new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
});

const buildStockCreditAlerts = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() + WARNING_DAYS * DAY_MS);
    const entries = await StockEntry.find({
        acquisitionType: { $in: ['credit', 'advance'] },
        creditAmount: { $gt: 0 },
        creditDueDate: { $ne: null, $lte: cutoff },
    })
        .select('batchRef creditDueDate buyingPrice quantity creditAmount product supplierRef')
        .populate('product', 'name productId')
        .populate('supplierRef', 'name supplierId')
        .sort({ creditDueDate: 1 })
        .lean();

    return entries.map((entry) => {
        const dueDate = new Date(entry.creditDueDate);
        const diff = dueDate.getTime() - now.getTime();
        const overdue = diff < 0;
        const days = Math.floor(Math.abs(diff) / DAY_MS);

        return {
            _id: entry._id,
            batchRef: entry.batchRef,
            productName: entry.product?.name || '—',
            productId: entry.product?.productId || '',
            supplierName: entry.supplierRef?.name || '—',
            dueDate: dueDate.toISOString(),
            dueDateLabel: formatDate(dueDate),
            daysRemaining: overdue ? 0 : days,
            daysOverdue: overdue ? days : 0,
            status: overdue ? 'overdue' : 'due_soon',
            amount: entry.creditAmount || (entry.buyingPrice || 0) * (entry.quantity || 0),
        };
    });
};

const notifyStockCreditExpiry = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() + WARNING_DAYS * DAY_MS);
    const entries = await StockEntry.find({
        acquisitionType: { $in: ['credit', 'advance'] },
        creditAmount: { $gt: 0 },
        creditDueDate: { $ne: null, $lte: cutoff },
        creditExpiryNotifiedAt: null,
    })
        .select('batchRef creditDueDate buyingPrice quantity creditAmount advanceAmount product supplierRef')
        .populate('product', 'name')
        .populate('supplierRef', 'name')
        .lean();

    if (entries.length === 0) return 0;

    const recipients = await User.find({ role: { $in: ['admin', 'root'] } }).select('_id').lean();
    if (recipients.length === 0) return 0;

    let notified = 0;

    for (const entry of entries) {
        const claimed = await StockEntry.findOneAndUpdate(
            { _id: entry._id, creditExpiryNotifiedAt: null },
            { $set: { creditExpiryNotifiedAt: now } },
            { new: true }
        );
        if (!claimed) continue;

        const dueDate = new Date(entry.creditDueDate);
        const overdue = dueDate.getTime() < now.getTime();
        const productName = entry.product?.name || 'product';
        const supplierName = entry.supplierRef?.name || 'supplier';
        const outstanding = entry.creditAmount || (entry.buyingPrice || 0) * (entry.quantity || 0);
        const advancePart = Number(entry.advanceAmount || 0) > 0
            ? ` Advance paid: ${entry.advanceAmount}.`
            : '';
        const creditPart = ` Outstanding credit: ${outstanding}.${advancePart}`;
        const title = overdue
            ? `Stock credit overdue — ${entry.batchRef}`
            : `Stock credit expiring in ${WARNING_DAYS} days — ${entry.batchRef}`;
        const message = overdue
            ? `${productName} stock from ${supplierName} was due on ${formatDate(dueDate)} and is still marked as credit.${creditPart}`
            : `${productName} stock from ${supplierName} is due on ${formatDate(dueDate)}. Review the credit period.${creditPart}`;

        await Promise.all(recipients.map((user) => Notification.create({
            recipient: user._id,
            type: 'stock_credit',
            title,
            message,
            relatedId: entry._id,
        })));
        notified += 1;
    }

    return notified;
};

module.exports = { buildStockCreditAlerts, notifyStockCreditExpiry, WARNING_DAYS };
