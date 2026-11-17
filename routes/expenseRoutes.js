const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.use(restrictTo('admin', 'root'));

router.route('/')
    .get(expenseController.getExpenses)
    .post(expenseController.createExpense);

router.get('/stats', expenseController.getExpenseStats);
router.get('/report', expenseController.getExpenseReport);
router.post('/categories', expenseController.addExpenseCategory);

router.route('/:id')
    .get(expenseController.getExpenseById)
    .put(expenseController.updateExpense)
    .delete(expenseController.voidExpense);

module.exports = router;
