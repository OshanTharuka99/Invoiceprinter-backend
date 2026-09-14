const mongoose = require('mongoose');

const appliedDiscountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true },
    amount: { type: Number, default: 0 }
}, { _id: false });

const appliedTaxSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    value: { type: Number, required: true },
    amount: { type: Number, default: 0 }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
    invoiceNumber: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    invoiceDate: {
        type: Date,
        default: Date.now
    },
    creationMethod: {
        type: String,
        enum: ['automatic', 'manual'],
        required: true
    },
    clientRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client'
    },
    manualClientDetails: {
        title: { type: String, default: 'Mr' },
        organization: { type: String, trim: true, default: '' },
        name: { type: String, trim: true },
        address: { type: String, trim: true },
        telephoneNumber: { type: String, trim: true },
        emailAddress: { type: String, trim: true }
    },
    projectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project'
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'cheque', 'bank_transfer', 'credit'],
        required: true
    },
    creditPeriod: {
        duration: { type: Number, default: 0 },
        unit: { type: String, enum: ['days', 'weeks', 'months'], default: 'days' }
    },
    deliveryAddress: {
        type: String,
        trim: true,
        default: ''
    },
    customerPO: {
        type: String,
        trim: true,
        default: ''
    },
    items: [{
        productRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product'
        },
        manualName: { type: String, trim: true },
        quantity: { type: Number, required: true, min: 0 },
        unitPrice: { type: Number, required: true, min: 0 },
        unitCost: { type: Number, default: 0, min: 0 },
        lineTotal: { type: Number, required: true, min: 0 },
        serialNumbers: [{ type: String, trim: true }]
    }],
    subTotal: { type: Number, required: true, min: 0 },
    appliedDiscounts: [appliedDiscountSchema],
    discountTotal: { type: Number, default: 0 },
    hasTax: { type: Boolean, default: false },
    appliedTaxes: [appliedTaxSchema],
    taxTotal: { type: Number, default: 0 },
    finalTotal: { type: Number, required: true, min: 0 },
    hasAdvancePayment: { type: Boolean, default: false },
    advanceAmount: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'primary' },
    status: {
        type: String,
        enum: ['Paid', 'Unpaid', 'Pending', 'Cancelled'],
        default: 'Unpaid'
    },
    statusHistory: [{
        status: { type: String, required: true },
        note: { type: String, trim: true },
        editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        editedAt: { type: Date, default: Date.now }
    }],
    deliveryNoteRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DeliveryNote',
        default: null
    },
    quotationRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Quotation',
        default: null
    },
    originalInvoiceRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    cancellationNote: {
        type: String,
        trim: true,
        default: ''
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Invoice', invoiceSchema);
