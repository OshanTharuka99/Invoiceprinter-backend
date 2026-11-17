const mongoose = require('mongoose');

const stockEntrySchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product reference is required'],
            index: true,
        },
        batchRef: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        location: {
            type: String,
            trim: true,
            default: '',
        },
        buyingPrice: {
            type: Number,
            min: [0, 'Buying price cannot be negative'],
            default: 0,
        },
        quantity: {
            type: Number,
            required: [true, 'Quantity is required'],
            min: [0, 'Quantity cannot be negative'],
        },
        warrantyPeriod: {
            type: String,
            trim: true,
            default: '',
        },
        // Optional serial numbers — enforced unique per product at controller level
        serialNumbers: [
            {
                type: String,
                trim: true,
                uppercase: true,
            },
        ],
        hasSerialNumbers: {
            type: Boolean,
            default: false,
        },
        supplierRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Supplier',
            default: null,
        },
        supplierInvoiceNumber: {
            type: String,
            required: [true, 'Supplier invoice number is required'],
            trim: true,
            uppercase: true,
            index: true,
        },
        supplierDeliveryNumber: {
            type: String,
            trim: true,
            uppercase: true,
            default: '',
            index: true,
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        acquisitionType: {
            type: String,
            enum: ['cash', 'credit', 'advance'],
            default: 'cash',
        },
        advanceAmount: {
            type: Number,
            min: [0, 'Advance amount cannot be negative'],
            default: 0,
        },
        creditAmount: {
            type: Number,
            min: [0, 'Credit amount cannot be negative'],
            default: 0,
        },
        creditPeriod: {
            type: String,
            default: '',
        },
        creditDueDate: {
            type: Date,
            default: null,
            index: true,
        },
        creditExpiryNotifiedAt: {
            type: Date,
            default: null,
        },
        expenseRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Expense',
            default: null,
        },
        expenseNumber: {
            type: String,
            default: '',
        },
        addedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('StockEntry', stockEntrySchema);
