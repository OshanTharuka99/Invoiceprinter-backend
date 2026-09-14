const mongoose = require('mongoose');

const businessDetailsSchema = new mongoose.Schema({
    businessName: {
        type: String,
        required: [true, 'Business Name is required'],
        trim: true
    },
    organizationCode: {
        type: String,
        trim: true,
        default: ''
    },
    organizationCodeDocument: {
        type: String
    },
    businessType: {
        type: String,
        enum: ['Owner', 'Partnership', 'Pvt Ltd'],
        default: 'Owner'
    },
    registrationNumber: {
        type: String,
        trim: true
    },
    address: {
        type: String,
        trim: true
    },
    phoneNumber: {
        type: String,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true
    },
    fax: {
        type: String,
        trim: true
    },
    country: {
        type: String,
        default: 'Sri Lanka'
    },
    city: {
        type: String,
        trim: true
    },
    //Bank Details
    bankAccountNumber: {
        type: String,
        trim: true
    },
    bankAccountName: {
        type: String,
        trim: true
    },
    bankName: {
        type: String,
        trim: true
    },
    branchName: {
        type: String,
        trim: true
    },
    //Currency
    primaryCurrency: {
        code: { type: String, default: 'LKR' },
        symbol: { type: String, default: 'Rs.' }
    },
    secondaryCurrency: {
        code: { type: String, default: 'USD' },
        symbol: { type: String, default: '$' }
    },
    // Tax Configuration
    isVatRegistered: {
        type: Boolean,
        default: false
    },
    businessTinNumber: {
        type: String,
        trim: true
    },
    vatNumber: {
        type: String,
        trim: true
    },
    vatPercentage: {
        type: Number,
        default: 18
    },
    otherTaxes: [{
        name: String,
        type: {
            type: String,
            enum: ['percentage', 'fixed'],
            default: 'percentage'
        },
        value: {
            type: Number,
            default: 0
        }
    }],
    // Discount Configuration
    discountProfiles: [{
        name: String,
        type: {
            type: String,
            enum: ['percentage', 'fixed'],
            default: 'percentage'
        },
        value: {
            type: Number,
            default: 0
        },
        minBillAmount: {
            type: Number,
            default: 0
        }
    }],
    quotationLogo: {
        type: String // We will store this as a Base64 string for simplicity
    },
    quotationTerms: {
        type: String,
        trim: true,
        default: 'Standard terms and conditions apply.'
    },
    quotationNotes: {
        type: String,
        trim: true,
        default: ''
    },
    invoiceTerms: {
        type: String,
        trim: true,
        default: 'Standard invoice terms and conditions apply.'
    },
    invoiceNotes: {
        type: String,
        trim: true,
        default: ''
    },
    purchaseOrderTerms: {
        type: String,
        trim: true,
        default: 'Standard purchase order terms and conditions apply.'
    },
    purchaseOrderNotes: {
        type: String,
        trim: true,
        default: ''
    },
    // Document formatting configuration
    quotationPrefix: { type: String, default: 'QN', trim: true },
    quotationDigits: { type: Number, default: 5 },
    quotationTitleColor: { type: String, default: '#0f172a' },
    quotationDividerColor: { type: String, default: '#0f172a' },
    quotationTemplateFormat: { type: String, enum: ['format1', 'format2'], default: 'format1' },

    invoicePrefix: { type: String, default: 'INV', trim: true },
    invoiceDigits: { type: Number, default: 5 },
    invoiceTitleColor: { type: String, default: '#0f172a' },
    invoiceDividerColor: { type: String, default: '#0f172a' },
    invoiceTemplateFormat: { type: String, enum: ['format1', 'format2'], default: 'format1' },

    promaInvoicePrefix: { type: String, default: 'PI', trim: true },
    promaInvoiceDigits: { type: Number, default: 5 },
    promaInvoiceTitleColor: { type: String, default: '#0f172a' },
    promaInvoiceDividerColor: { type: String, default: '#0f172a' },
    promaInvoiceTerms: { type: String, trim: true, default: 'This is a proforma / estimate document only. It does not affect stock or warranties.' },
    promaInvoiceNotes: { type: String, trim: true, default: '' },

    purchaseOrderPrefix: { type: String, default: 'PO', trim: true },
    purchaseOrderDigits: { type: Number, default: 5 },
    purchaseOrderTitleColor: { type: String, default: '#0284c7' },
    purchaseOrderDividerColor: { type: String, default: '#0284c7' },

    deliveryNotePrefix: { type: String, default: 'DN', trim: true },
    deliveryNoteDigits: { type: Number, default: 5 },
    deliveryNoteTitleColor: { type: String, default: '#8b5cf6' },
    deliveryNoteDividerColor: { type: String, default: '#8b5cf6' },
    deliveryNoteTerms: { type: String, trim: true, default: 'Standard delivery terms apply.' },
    deliveryNoteNotes: { type: String, trim: true, default: '' },
    salesReturnPrefix: { type: String, default: 'SRN', trim: true },
    salesReturnDigits: { type: Number, default: 5 },
    salesReturnTitleColor: { type: String, default: '#b91c1c' },
    salesReturnDividerColor: { type: String, default: '#b91c1c' },
    salesReturnTerms: { type: String, trim: true, default: 'Returned goods accepted as per policy.' },
    salesReturnNotes: { type: String, trim: true, default: '' },
    salesReturnValidityDuration: { type: Number, default: 30, min: 1 },
    salesReturnValidityUnit: { type: String, enum: ['days', 'weeks', 'months', 'years'], default: 'days' },
    goodsReturnPrefix: { type: String, default: 'GRN', trim: true },
    goodsReturnDigits: { type: Number, default: 5 },
    goodsReturnTitleColor: { type: String, default: '#0f766e' },
    goodsReturnDividerColor: { type: String, default: '#0f766e' },
    goodsReturnTerms: { type: String, trim: true, default: 'Goods returned to supplier as per purchase terms.' },
    goodsReturnNotes: { type: String, trim: true, default: '' },
    rmaPrefix: { type: String, default: 'RMA', trim: true },
    rmaDigits: { type: Number, default: 5 },
    rmaTitleColor: { type: String, default: '#c2410c' },
    rmaDividerColor: { type: String, default: '#c2410c' },
    rmaTerms: { type: String, trim: true, default: 'RMA processed as per company warranty / service policy.' },
    rmaNotes: { type: String, trim: true, default: '' },
    cashReceiptPrefix: { type: String, default: 'CR', trim: true },
    cashReceiptDigits: { type: Number, default: 5 },
    cashReceiptTitleColor: { type: String, default: '#0f172a' },
    cashReceiptDividerColor: { type: String, default: '#0f172a' },
    cashReceiptLogo: { type: String, trim: true, default: '' },
    cashReceiptTerms: { type: String, trim: true, default: '' },
    cashReceiptNotes: { type: String, trim: true, default: '' },
    defaultWarrantyPeriod: { type: String, trim: true, default: '1 year' },
    // Page size configuration
    pageSizePreset: { type: String, default: 'A4' },
    pageWidth: { type: Number, default: 210 },
    pageHeight: { type: Number, default: 297 },
    iconColor: { type: String, default: '#3b82f6' },
    stores: [{
        name: { type: String, trim: true },
        address: { type: String, trim: true },
        phoneNumber: { type: String, trim: true }
    }]
}, {
    timestamps: true
});

module.exports = mongoose.model('BusinessDetails', businessDetailsSchema);
