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
    const dateStr = clockIn.slice(0, 10);

    // Find the WCF covering this date
    let wcfId = null;
    const wcfResult = await conn.query(
      `SELECT Id FROM Weekly_Cash_Flow__c WHERE Start_Date__c <= ${dateStr} AND End_Date__c >= ${dateStr} ORDER BY Start_Date__c DESC LIMIT 1`
    );
    if (wcfResult.records.length > 0) {
      wcfId = wcfResult.records[0].Id;
    } else {
      const fallback = await conn.query(`SELECT Id FROM Weekly_Cash_Flow__c ORDER BY End_Date__c DESC NULLS LAST LIMIT 1`);
      if (fallback.records.length > 0) wcfId = fallback.records[0].Id;
    }

    const fields = { Date__c: dateStr, Clock_In__c: clockIn };
    if (wcfId) fields.Weekly_Cash_Flow__c = wcfId;

    const result = await conn.sobject('Daily_Cash_Flow__c').create(fields);
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

// Weekly report — summary + daily breakdown + vs last week
router.get('/weekly-report', async (req, res) => {
  try {
    const conn = await getConnection();

    // Find Monday of current week
    const today = new Date();
    const dow = today.getDay(); // 0=Sun
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    const mondayStr = monday.toISOString().slice(0, 10);

    const [wcfRes, dailyRes, lastWeekRes] = await Promise.all([
      conn.query(`
        SELECT Weekly_Total_Income__c, Weekly_Total_Expenses__c, Net_Profit__c,
               Weekly_Shift_Hours__c, Weekly_Active_Hours__c,
               Earnings_Per_Shift_Hour__c, Earnings_Per_Active_Hour__c,
               Weekly_Shift_Miles__c, Start_Date__c, End_Date__c
        FROM Weekly_Cash_Flow__c
        WHERE Start_Date__c <= ${mondayStr} AND End_Date__c >= ${mondayStr}
        ORDER BY Start_Date__c DESC LIMIT 1
      `),
      conn.query(`
        SELECT Date__c,
               SUM(Total_Income__c) dailyIncome,
               SUM(Total_Expenses__c) dailyExpenses,
               SUM(Shift_Hours__c) shiftHours,
               SUM(Active_Time_Hours__c) activeHours
        FROM Daily_Cash_Flow__c
        WHERE Date__c >= ${mondayStr}
          AND Date__c <= ${new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10)}
        GROUP BY Date__c
        ORDER BY Date__c ASC
      `),
      conn.query(`
        SELECT Weekly_Total_Income__c, Net_Profit__c, Earnings_Per_Shift_Hour__c, Weekly_Shift_Hours__c
        FROM Weekly_Cash_Flow__c
        ORDER BY Start_Date__c DESC LIMIT 2
      `)
    ]);

    const wcf = wcfRes.records[0] || null;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = dailyRes.records.map(d => {
      const dt = new Date(d.Date__c + 'T12:00:00Z');
      const income = d.dailyIncome || 0;
      const hours = d.shiftHours || 0;
      return {
        date: d.Date__c,
        dayName: dayNames[dt.getUTCDay()],
        income,
        expenses: d.dailyExpenses || 0,
        netProfit: income - (d.dailyExpenses || 0),
        shiftHours: hours,
        activeHours: d.activeHours || 0,
        ratePerShiftHour: hours > 0 ? Math.round((income / hours) * 100) / 100 : 0
      };
    });

    const bestDay = days.reduce((best, d) => (!best || d.income > best.income) ? d : best, null);

    // lastWeekRes returns most recent 2; second record is last week if this week exists
    const lastWcf = lastWeekRes.records.length > 1 ? lastWeekRes.records[1] : null;

    res.json({ week: wcf, days, bestDay, lastWeek: lastWcf });
  } catch (err) {
    console.error('[WeeklyReport]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;