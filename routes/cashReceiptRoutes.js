const express = require('express');
const router = express.Router();
const cashReceiptController = require('../controllers/cashReceiptController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.use(restrictTo('admin', 'root'));

router.route('/')
    .get(cashReceiptController.getCashReceipts)
    .post(cashReceiptController.createCashReceipt);

router.route('/advances')
    .get(cashReceiptController.getAdvanceReceipts);

router.route('/:id')
    .get(cashReceiptController.getCashReceiptById)
    .delete(cashReceiptController.voidCashReceipt);

module.exports = router;