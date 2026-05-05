const express = require('express');
const router = express.Router();
const jsforce = require('jsforce');

async function getConnection() {
  const conn = new jsforce.Connection({
    loginUrl: 'https://login.salesforce.com'
  });
  await conn.login(
    process.env.SF_USERNAME,
    process.env.SF_PASSWORD
  );
  return conn;
}

// Weekly total
router.get('/weekly', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.query(`
      SELECT SUM(Total_Earnings__c) total
      FROM Income_Record__c
      WHERE Income_Date__c = THIS_WEEK
    `);
    res.json({ total: result.records[0].total || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Monthly total
router.get('/monthly', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.query(`
      SELECT SUM(Total_Earnings__c) total
      FROM Income_Record__c
      WHERE Income_Date__c = THIS_MONTH
    `);
    res.json({ total: result.records[0].total || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 6 month trend
router.get('/trend', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.query(`
      SELECT CALENDAR_MONTH(Income_Date__c) mo,
             CALENDAR_YEAR(Income_Date__c) yr,
             SUM(Total_Earnings__c) total
      FROM Income_Record__c
      WHERE Income_Date__c = LAST_N_MONTHS:6
      GROUP BY CALENDAR_MONTH(Income_Date__c),
               CALENDAR_YEAR(Income_Date__c)
      ORDER BY CALENDAR_YEAR(Income_Date__c),
               CALENDAR_MONTH(Income_Date__c)
    `);
    res.json({ trend: result.records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get active shift — returns open Daily_Cash_Flow__c for today if one exists
router.get('/shift/active', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.query(`
      SELECT Id, Clock_In__c, Date__c FROM Daily_Cash_Flow__c
      WHERE Clock_In__c != null AND Clock_Out__c = null AND Date__c = TODAY
      ORDER BY CreatedDate DESC LIMIT 1
    `);
    if (result.records.length === 0) return res.json({ active: false });
    const dcf = result.records[0];
    res.json({ active: true, recordId: dcf.Id, clockIn: dcf.Clock_In__c });
  } catch (err) {
    console.error('[Shift/Active]', err);
    res.status(500).json({ error: err.message });
  }
});

// Start a shift — creates an open Daily_Cash_Flow__c (no clock-out yet)
router.post('/shift/start', async (req, res) => {
  const { clockIn } = req.body;
  if (!clockIn) return res.status(400).json({ error: 'clockIn required' });
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
  if (!isoRe.test(clockIn)) return res.status(400).json({ error: 'Invalid datetime format' });
  try {
    const conn = await getConnection();
    const result = await conn.sobject('Daily_Cash_Flow__c').create({
      Date__c: clockIn.slice(0, 10),
      Clock_In__c: clockIn
    });
    if (!result.success) throw new Error((result.errors || []).join(', ') || 'Create failed');
    res.json({ success: true, recordId: result.id });
  } catch (err) {
    console.error('[Shift/Start]', err);
    res.status(500).json({ error: err.message });
  }
});

// End a shift — closes the open Daily_Cash_Flow__c
router.post('/shift/end', async (req, res) => {
  const { recordId, clockOut, miles } = req.body;
  if (!recordId || !clockOut) return res.status(400).json({ error: 'recordId and clockOut required' });
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
  if (!isoRe.test(clockOut)) return res.status(400).json({ error: 'Invalid datetime format' });
  try {
    const conn = await getConnection();
    const result = await conn.sobject('Daily_Cash_Flow__c').update({
      Id: recordId,
      Clock_Out__c: clockOut,
      Total_Shift_Miles__c: parseFloat(miles) || 0
    });
    if (!result.success) throw new Error((result.errors || []).join(', ') || 'Update failed');
    res.json({ success: true, recordId });
  } catch (err) {
    console.error('[Shift/End]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;