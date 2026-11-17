const Expense = require('../models/Expense');
const BusinessDetails = require('../models/BusinessDetails');
const Project = require('../models/Project');
require('../models/Client');
require('../models/User');
const { DEFAULT_EXPENSE_CATEGORY_NAMES, ensureExpenseCategories } = require('../utils/defaultExpenseCategories');

const EXPENSE_PREFIX = 'EXP';
const EXPENSE_DIGITS = 5;
const EDIT_WINDOW_DAYS = 14;

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isWithinEditWindow = (createdAt) => {
    const diffMs = Date.now() - new Date(createdAt).getTime();
    return diffMs <= EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
};

const generateExpenseNumber = async () => {
    const bizDetails = await BusinessDetails.findOne();
    const orgCode = String(bizDetails?.organizationCode || '').trim().toUpperCase() || 'ORG';
    const prefix = String(bizDetails?.expensePrefix || EXPENSE_PREFIX).toUpperCase();
    const digits = bizDetails?.expenseDigits || EXPENSE_DIGITS;

    const fullPrefix = `${orgCode}/${prefix}/`;
    const escapedPrefix = escapeRegex(fullPrefix);
    const latest = await Expense.findOne({
        expenseNumber: new RegExp('^' + escapedPrefix)
    }).sort({ createdAt: -1 });

    let sequence = 1;
    if (latest && latest.expenseNumber) {
        const suffixStr = latest.expenseNumber.substring(fullPrefix.length);
        const num = parseInt(suffixStr, 10);
        if (!isNaN(num)) sequence = num + 1;
    }
    return `${fullPrefix}${String(sequence).padStart(digits, '0')}`;
};

module.exports.generateExpenseNumber = generateExpenseNumber;

const getActiveExpenseCategoryNames = async () => {
    const details = await BusinessDetails.findOne();
    return ensureExpenseCategories(details)
        .filter((cat) => cat && cat.isActive !== false)
        .map((cat) => String(cat.name || '').trim().toLowerCase())
        .filter(Boolean);
};

const validateExpenseInput = async (body) => {
    const { name, paidTo, billNumber, categoryName, purpose, amount, paymentMethod, projectRef, chequeNumber } = body;

    if (!name || !String(name).trim()) return 'Expense name is required';
    if (!paidTo || !String(paidTo).trim()) return 'Paid to is required';
    if (!billNumber || !String(billNumber).trim()) return 'Bill number is required';
    if (!categoryName || !String(categoryName).trim()) return 'Expense category is required';
    if (!['project', 'office', 'asset'].includes(purpose)) return 'Purpose must be project, office or asset';

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return 'Amount must be greater than zero';
    if (!['cash', 'cheque', 'bank_transfer'].includes(paymentMethod)) return 'Payment method is required';

    if (purpose === 'project') {
        if (!projectRef) return 'A project expense must be linked to a project';
        const project = await Project.findById(projectRef);
        if (!project) return 'Project not found';
    }
    if (paymentMethod === 'cheque' && (!chequeNumber || !String(chequeNumber).trim())) {
        return 'Cheque number is required for cheque payments';
    }

    const activeNames = await getActiveExpenseCategoryNames();
    if (!activeNames.includes(String(categoryName).trim().toLowerCase())) return 'Invalid expense category';
    return null;
};

const populateExpense = (query) =>
    query
        .populate({
            path: 'projectRef',
            select: 'name projectId client',
            populate: { path: 'client', select: 'firstName lastName organization telephoneNumber' }
        })
        .populate('createdBy', 'firstName lastName')
        .populate('voidedBy', 'firstName lastName');

const getClientName = (project) => {
    if (!project?.client) return '';
    return [project.client.firstName, project.client.lastName].filter(Boolean).join(' ') || project.client.organization || '';
};

exports.getExpenses = async (req, res) => {
    try {
        const { status, search, dateFrom, dateTo, purpose, categoryName, projectId, paymentMethod } = req.query;
        const filter = {};

        if (status && ['recorded', 'void'].includes(status)) filter.status = status;
        if (purpose && ['project', 'office', 'asset'].includes(purpose)) filter.purpose = purpose;
        if (categoryName && String(categoryName).trim()) {
            filter.categoryName = new RegExp('^' + escapeRegex(String(categoryName).trim()) + '$', 'i');
        }
        if (projectId && String(projectId).trim()) filter.projectRef = projectId;
        if (paymentMethod && ['cash', 'cheque', 'bank_transfer'].includes(paymentMethod)) filter.paymentMethod = paymentMethod;
        if (dateFrom || dateTo) {
            filter.expenseDate = {};
            if (dateFrom) filter.expenseDate.$gte = new Date(dateFrom);
            if (dateTo) {
                const to = new Date(dateTo);
                if (!isNaN(to.getTime())) to.setHours(23, 59, 59, 999);
                filter.expenseDate.$lte = to;
            }
        }

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfYear = new Date(now.getFullYear(), 0, 1);

        const [expenses, todayAgg, monthAgg, yearAgg, voidedCount] = await Promise.all([
            populateExpense(Expense.find(filter)).sort({ expenseDate: -1 }).lean(),
            Expense.aggregate([
                { $match: { status: 'recorded', expenseDate: { $gte: startOfToday } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.aggregate([
                { $match: { status: 'recorded', expenseDate: { $gte: startOfMonth } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.aggregate([
                { $match: { status: 'recorded', expenseDate: { $gte: startOfYear } } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.countDocuments({ status: 'void' })
        ]);

        let list = expenses;
        if (search && String(search).trim()) {
            const term = String(search).trim().toLowerCase();
            list = list.filter(e =>
                String(e.expenseNumber || '').toLowerCase().includes(term) ||
                String(e.name || '').toLowerCase().includes(term) ||
                String(e.paidTo || '').toLowerCase().includes(term) ||
                String(e.billNumber || '').toLowerCase().includes(term)
            );
        }

        res.status(200).json({
            success: true,
            stats: {
                todayTotal: todayAgg[0]?.total || 0,
                todayCount: todayAgg[0]?.count || 0,
                monthTotal: monthAgg[0]?.total || 0,
                monthCount: monthAgg[0]?.count || 0,
                yearTotal: yearAgg[0]?.total || 0,
                voidedCount
            },
            data: list
        });
    } catch (error) {
        console.error('getExpenses error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getExpenseById = async (req, res) => {
    try {
        const expense = await populateExpense(Expense.findById(req.params.id));
        if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
        res.status(200).json({ success: true, data: expense });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createExpense = async (req, res) => {
    try {
        const {
            name,
            expenseDate,
            paidTo,
            billNumber,
            categoryName,
            purpose,
            projectRef,
            amount,
            paymentMethod,
            chequeNumber,
            notes
        } = req.body;

        const validationMessage = await validateExpenseInput(req.body);
        if (validationMessage) return res.status(400).json({ success: false, message: validationMessage });

        const expenseNumber = await generateExpenseNumber();
        const expense = await Expense.create({
            expenseNumber,
            name: String(name).trim(),
            expenseDate: expenseDate || Date.now(),
            paidTo: String(paidTo).trim(),
            billNumber: String(billNumber).trim(),
            categoryName: String(categoryName).trim(),
            purpose,
            projectRef: purpose === 'project' ? projectRef || null : null,
            amount: Number(amount),
            paymentMethod,
            chequeNumber: paymentMethod === 'cheque' ? String(chequeNumber).trim() : '',
            notes: notes || '',
            createdBy: req.user._id,
            status: 'recorded'
        });

        const populated = await populateExpense(Expense.findById(expense._id));
        res.status(201).json({ success: true, data: populated });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateExpense = async (req, res) => {
    try {
        const expense = await Expense.findById(req.params.id);
        if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
        if (expense.status === 'void') {
            return res.status(400).json({ success: false, message: 'A voided expense cannot be edited' });
        }
        if (!isWithinEditWindow(expense.createdAt)) {
            return res.status(400).json({
                success: false,
                message: `Editing is only allowed within ${EDIT_WINDOW_DAYS} days of creating the expense`
            });
        }

        const validationMessage = await validateExpenseInput(req.body);
        if (validationMessage) return res.status(400).json({ success: false, message: validationMessage });

        const {
            name,
            expenseDate,
            paidTo,
            billNumber,
            categoryName,
            purpose,
            amount,
            paymentMethod,
            projectRef,
            chequeNumber,
            notes
        } = req.body;

        expense.name = String(name).trim();
        if (expenseDate) expense.expenseDate = expenseDate;
        expense.paidTo = String(paidTo).trim();
        expense.billNumber = String(billNumber).trim();
        expense.categoryName = String(categoryName).trim();
        expense.purpose = purpose;
        expense.projectRef = purpose === 'project' ? projectRef || null : null;
        expense.amount = Number(amount);
        expense.paymentMethod = paymentMethod;
        expense.chequeNumber = paymentMethod === 'cheque' ? String(chequeNumber).trim() : '';
        expense.notes = notes || '';

        await expense.save();

        const populated = await populateExpense(Expense.findById(expense._id)).lean();
        res.status(200).json({ success: true, message: 'Expense updated successfully', data: populated });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.voidExpense = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'Void reason is required' });
        }

        const expense = await Expense.findById(req.params.id);
        if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
        if (!isWithinEditWindow(expense.createdAt)) {
            return res.status(400).json({
                success: false,
                message: `Voiding is only allowed within ${EDIT_WINDOW_DAYS} days of creating the expense`
            });
        }
        if (expense.status === 'void') {
            return res.status(400).json({ success: false, message: 'Expense is already void' });
        }

        expense.status = 'void';
        expense.voidNote = String(reason).trim();
        expense.voidedBy = req.user._id;
        await expense.save();

        res.status(200).json({ success: true, message: 'Expense voided successfully', data: expense });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const buildExpensePeriodMatch = (period) => {
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

    return {
        period: ['daily', 'monthly', 'yearly'].includes(period) ? period : 'yearly',
        start,
        end,
        dateFormat,
        match: { expenseDate: { $gte: start, $lt: end }, status: { $ne: 'void' } }
    };
};

const collectTotals = (rows) => rows.reduce((acc, row) => {
    acc.total += row.total || 0;
    acc.count += row.count || 0;
    return acc;
}, { total: 0, count: 0 });

exports.getExpenseStats = async (req, res) => {
    try {
        const { period } = req.query;
        const { period: activePeriod, start, end, dateFormat, match } = buildExpensePeriodMatch(period);

        const [totals, purposeAgg, paymentAgg, categoryAgg, overTimeAgg] = await Promise.all([
            Expense.aggregate([
                { $match: match },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$purpose', total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$categoryName', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } }
            ]),
            Expense.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { $dateToString: { format: dateFormat, date: '$expenseDate' } },
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
        ]);

        const byPurpose = { project: 0, office: 0, asset: 0 };
        purposeAgg.forEach((row) => {
            if (row._id && byPurpose[row._id] !== undefined) byPurpose[row._id] = row.total || 0;
        });

        const byPaymentMethod = { cash: 0, cheque: 0, bank_transfer: 0 };
        paymentAgg.forEach((row) => {
            if (row._id && byPaymentMethod[row._id] !== undefined) byPaymentMethod[row._id] = row.total || 0;
        });

        res.status(200).json({
            success: true,
            data: {
                period: activePeriod,
                dateRange: { start, end },
                totalExpenses: totals[0]?.total || 0,
                expenseCount: totals[0]?.count || 0,
                byPurpose,
                byPaymentMethod,
                byCategory: categoryAgg.map((row) => ({ name: row._id || 'Uncategorized', total: row.total || 0, count: row.count || 0 })),
                expensesOverTime: overTimeAgg.map((row) => ({ date: row._id, total: row.total || 0 }))
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getReportRange = (period, anchor) => {
    const activePeriod = ['daily', 'weekly', 'monthly', 'yearly'].includes(period) ? period : 'monthly';
    const date = new Date(anchor || Date.now());
    const reference = isNaN(date.getTime()) ? new Date() : date;
    let start;
    let end;
    let bucketFormat;

    if (activePeriod === 'daily') {
        start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
        end = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1);
        bucketFormat = '%Y-%m-%d';
    } else if (activePeriod === 'weekly') {
        const mondayOffset = (reference.getDay() + 6) % 7;
        start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - mondayOffset);
        end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
        bucketFormat = '%Y-%m-%d';
    } else if (activePeriod === 'monthly') {
        start = new Date(reference.getFullYear(), reference.getMonth(), 1);
        end = new Date(reference.getFullYear(), reference.getMonth() + 1, 1);
        bucketFormat = '%Y-%m-%d';
    } else {
        start = new Date(reference.getFullYear(), 0, 1);
        end = new Date(reference.getFullYear() + 1, 0, 1);
        bucketFormat = '%Y-%m';
    }

    return { activePeriod, start, end, bucketFormat };
};

exports.getExpenseReport = async (req, res) => {
    try {
        const { scope, period, projectId, date, refDate } = req.query;
        const activeScope = scope === 'project' ? 'project' : 'base';
        if (activeScope === 'project' && (!projectId || !String(projectId).trim())) {
            return res.status(400).json({ success: false, message: 'Project is required for a project expense report' });
        }

        const { activePeriod, start, end, bucketFormat } = getReportRange(period, date || refDate);
        const match = { status: 'recorded', expenseDate: { $gte: start, $lt: end } };
        if (activeScope === 'project' && projectId) match.projectRef = projectId;

        const [categoryAgg, purposeAgg, paymentAgg, overTimeAgg, rows, projectDoc] = await Promise.all([
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$categoryName', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } }
            ]),
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$purpose', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } }
            ]),
            Expense.aggregate([
                { $match: match },
                { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { total: -1 } }
            ]),
            Expense.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { $dateToString: { format: bucketFormat, date: '$expenseDate' } },
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            populateExpense(Expense.find(match)).sort({ expenseDate: -1 }).lean(),
            projectId
                ? Project.findById(projectId).populate('client', 'firstName lastName organization')
                : Promise.resolve(null)
        ]);

        const totals = collectTotals(overTimeAgg);
        const label = activePeriod.charAt(0).toUpperCase() + activePeriod.slice(1);
        const title = `${activeScope === 'project' ? 'Project' : 'Company-wide'} Expense Report — ${label}`;

        res.status(200).json({
            success: true,
            data: {
                scope: activeScope,
                period: activePeriod,
                title,
                dateRange: { start, end },
                project: projectDoc ? { name: projectDoc.name, clientName: getClientName(projectDoc) } : null,
                total: totals.total,
                count: totals.count,
                breakdown: {
                    category: categoryAgg.map((row) => ({ name: row._id || 'Uncategorized', total: row.total || 0, count: row.count || 0 })),
                    purpose: purposeAgg.map((row) => ({ name: row._id || 'Unknown', total: row.total || 0, count: row.count || 0 })),
                    paymentMethod: paymentAgg.map((row) => ({ name: row._id || 'Unknown', total: row.total || 0, count: row.count || 0 })),
                    date: overTimeAgg.map((row) => ({ name: row._id, total: row.total || 0, count: row.count || 0 }))
                },
                rows
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.addExpenseCategory = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'Category name is required' });
        }

        const trimmed = String(name).trim();
        const normalized = trimmed.toLowerCase();
        const details = await BusinessDetails.findOne();
        if (!details) {
            return res.status(400).json({ success: false, message: 'Business details not found' });
        }

        const categories = ensureExpenseCategories(details);
        const defaultKeys = DEFAULT_EXPENSE_CATEGORY_NAMES.map((item) => item.toLowerCase());
        const exists = defaultKeys.includes(normalized) || categories.some((cat) =>
            String(cat?.name || '').trim().toLowerCase() === normalized ||
            String(cat?.key || '').trim().toLowerCase() === normalized
        );
        if (exists) {
            return res.status(400).json({ success: false, message: 'Expense category already exists' });
        }

        details.expenseCategories = [
            ...categories,
            { name: trimmed, isDefault: false, isActive: true }
        ];
        await details.save();

        res.status(200).json({ success: true, data: details.expenseCategories });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
