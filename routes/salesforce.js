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

module.exports = router;