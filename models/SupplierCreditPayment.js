const mongoose = require('mongoose');

const supplierCreditPaymentSchema = new mongoose.Schema({
    supplier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Supplier',
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'cheque', 'bank'],
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
    expenseRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Expense',
        default: null
    },
    expenseNumber: {
        type: String,
        default: ''
    },
    allocations: [
        {
            stockEntry: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'StockEntry',
                required: true
            },
            amount: {
                type: Number,
                required: true
            }
        }
    ],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('SupplierCreditPayment', supplierCreditPaymentSchema);
