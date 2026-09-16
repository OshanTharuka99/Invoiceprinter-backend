const Project = require('../models/Project');
const Invoice = require('../models/Invoice');
const CashReceipt = require('../models/CashReceipt');
const { nextObjectId } = require('../utils/objectId');

const computeProjectFinancials = async (projectId) => {
    const pid = projectId;

    const [creditInvoiced, creditPaid, advances] = await Promise.all([
        Invoice.aggregate([
            { $match: { projectId: pid, paymentMethod: 'credit', status: { $ne: 'Cancelled' } } },
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
            { $match: { 'invs.projectId': pid, 'invs.paymentMethod': 'credit', 'invs.status': { $ne: 'Cancelled' } } },
            { $group: { _id: null, total: { $sum: '$amountReceived' } } },
        ]),
        CashReceipt.find({
            status: 'issued',
            receiptType: 'advance',
            projectRef: projectId,
            appliedToInvoice: null
        })
            .populate('clientRef', 'firstName lastName organization')
            .sort({ createdAt: -1 })
            .lean(),
    ]);

    return {
        creditValue: Math.max(0, (creditInvoiced[0]?.total || 0) - (creditPaid[0]?.total || 0)),
        advanceReceipts: advances,
        advanceTotal: advances.reduce((sum, r) => sum + (Number(r.amountReceived) || 0), 0),
    };
};

module.exports.computeProjectFinancials = computeProjectFinancials;

exports.createProject = async (req, res) => {
    try {
        const projectId = await nextObjectId(Project, 'Project', 'projectId');

        const project = await Project.create({ ...req.body, projectId });
        res.status(201).json({ success: true, data: project });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.getProjects = async (req, res) => {
    try {
        const projects = await Project.find().populate('client').sort({ createdAt: -1 }).lean();
        const enriched = await Promise.all(projects.map(async (p) => {
            const fin = await computeProjectFinancials(p._id);
            return { ...p, ...fin };
        }));
        res.status(200).json({ success: true, data: enriched });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.updateProject = async (req, res) => {
    try {
        const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
        res.status(200).json({ success: true, data: project });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.deleteProject = async (req, res) => {
     try {
        const project = await Project.findByIdAndDelete(req.params.id);
        if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
        res.status(200).json({ success: true, message: 'Project deleted' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
