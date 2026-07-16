'use strict';

/**
 * Print Queue & Dispatcher
 * Manages label printing across multiple printer types (office, thermal, etc.)
 */
module.exports = function createPrintQueue(db) {

  const queuePrintJob = (labelData, options = {}) => {
    const {
      printerType = 'office',
      copies = 1,
      priority = 'normal',
      notes = '',
    } = options;

    const jobId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO print_jobs (id, label_data, printer_type, copies, priority, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(jobId, JSON.stringify(labelData), printerType, copies, priority, notes, now);

    return {
      jobId,
      status: 'queued',
      printerType,
      copies,
      priority,
      createdAt: now,
    };
  };

  const getPrintQueue = (printerType = null, status = 'queued') => {
    let sql = 'SELECT * FROM print_jobs WHERE status = ?';
    const params = [status];

    if (printerType) {
      sql += ' AND printer_type = ?';
      params.push(printerType);
    }

    sql += " ORDER BY CASE WHEN priority = 'high' THEN 1 WHEN priority = 'normal' THEN 2 ELSE 3 END, created_at";

    return db.prepare(sql).all(...params).map(job => ({
      ...job,
      labelData: JSON.parse(job.label_data || '{}'),
    }));
  };

  const startPrintJob = (jobId) => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error('Print job not found');
    if (job.status !== 'queued') throw new Error(`Job is ${job.status}, cannot start`);

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE print_jobs
      SET status = 'printing', started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, jobId);

    return {
      jobId,
      status: 'printing',
      startedAt: now,
    };
  };

  const completePrintJob = (jobId) => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error('Print job not found');
    if (job.status !== 'printing') throw new Error(`Job is ${job.status}, cannot complete`);

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE print_jobs
      SET status = 'printed', printed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, jobId);

    return {
      jobId,
      status: 'printed',
      printedAt: now,
    };
  };

  const failPrintJob = (jobId, errorMessage = '') => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error('Print job not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE print_jobs
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(errorMessage, now, jobId);

    return {
      jobId,
      status: 'failed',
      errorMessage,
      failedAt: now,
    };
  };

  const getPrintJobStatus = (jobId) => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
    if (!job) return null;

    return {
      jobId,
      status: job.status,
      printerType: job.printer_type,
      copies: job.copies,
      priority: job.priority,
      createdAt: job.created_at,
      startedAt: job.started_at,
      printedAt: job.printed_at,
      errorMessage: job.error_message,
      labelData: JSON.parse(job.label_data || '{}'),
    };
  };

  const getPrintStats = () => {
    const stats = db.prepare(`
      SELECT
        status,
        printer_type,
        COUNT(*) as count,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high_priority
      FROM print_jobs
      GROUP BY status, printer_type
    `).all();

    const printerStats = {};
    let totals = { queued: 0, printing: 0, printed: 0, failed: 0 };

    for (const row of stats) {
      if (!printerStats[row.printer_type]) {
        printerStats[row.printer_type] = { queued: 0, printing: 0, printed: 0, failed: 0 };
      }
      printerStats[row.printer_type][row.status] = row.count;
      totals[row.status] += row.count;
    }

    return {
      byPrinter: printerStats,
      totals,
      timestamp: new Date().toISOString(),
    };
  };

  const clearCompletedJobs = (daysOld = 7) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = db.prepare(`
      DELETE FROM print_jobs
      WHERE status IN ('printed', 'failed')
      AND printed_at < ?
    `).run(cutoffDate.toISOString());

    return {
      jobsDeleted: result.changes,
      cutoffDate: cutoffDate.toISOString(),
    };
  };

  return {
    queuePrintJob,
    getPrintQueue,
    startPrintJob,
    completePrintJob,
    failPrintJob,
    getPrintJobStatus,
    getPrintStats,
    clearCompletedJobs,
  };
};
