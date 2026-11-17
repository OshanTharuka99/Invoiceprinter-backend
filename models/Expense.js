const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    expenseNumber: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    expenseDate: {
        type: Date,
        required: true,
        default: Date.now
    },
    paidTo: {
        type: String,
        required: true,
        trim: true
    },
    billNumber: {
        type: String,
        required: [true, 'Bill number is required'],
        trim: true
    },
    categoryName: {
        type: String,
        required: true,
        trim: true
    },
    purpose: {
        type: String,
        enum: ['project', 'office', 'asset'],
        required: true
    },
    projectRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        default: null
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'cheque', 'bank_transfer'],
        required: true
    },
    chequeNumber: {
        type: String,
        trim: true,
        default: ''
    },
    notes: {
        type: String,
        trim: true,
        default: ''
    },
    status: {
        type: String,
        enum: ['recorded', 'void'],
        default: 'recorded'
    },
    voidNote: {
        type: String,
        trim: true,
        default: ''
    },
    voidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

expenseSchema.index({ expenseDate: -1, status: 1 });
expenseSchema.index({ projectRef: 1, status: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
