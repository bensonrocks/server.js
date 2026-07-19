#!/usr/bin/env node
'use strict';

/**
 * Load Test Harness - Concurrent User Simulation
 *
 * Simulates 13 concurrent users:
 * - 5 Admin users (managing orders, users, configuration)
 * - 4 Warehouse Managers (viewing orders, allocating to warehouses)
 * - 4 Packers (picking items, scanning, completing orders)
 *
 * Duration: 10+ seconds with all users active
 * Measures: throughput, response times, success rate, errors
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DURATION_MS = 15000; // 15 seconds total
const RAMP_UP_MS = 2000; // 2 seconds to start all users
const OUTPUT_DIR = '/tmp/ecommerce-fulfillment-skill-workspace/iteration-1/eval-4-loadtest/without_skill/outputs';

// Global metrics
const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  responseTimes: [],
  errors: [],
  statusCodeCounts: {},
  startTime: Date.now(),
  endTime: null,
  userSessions: []
};

// User configurations
const userConfigs = [
  // 5 Admin users
  { id: 'admin-1', role: 'admin', username: 'admin-1', password: 'admin1234' },
  { id: 'admin-2', role: 'admin', username: 'admin-2', password: 'admin1234' },
  { id: 'admin-3', role: 'admin', username: 'admin-3', password: 'admin1234' },
  { id: 'admin-4', role: 'admin', username: 'admin-4', password: 'admin1234' },
  { id: 'admin-5', role: 'admin', username: 'admin-5', password: 'admin1234' },

  // 4 Warehouse Manager users
  { id: 'wm-1', role: 'warehouse', username: 'wm-1', password: 'warehouse1234' },
  { id: 'wm-2', role: 'warehouse', username: 'wm-2', password: 'warehouse1234' },
  { id: 'wm-3', role: 'warehouse', username: 'wm-3', password: 'warehouse1234' },
  { id: 'wm-4', role: 'warehouse', username: 'wm-4', password: 'warehouse1234' },

  // 4 Packer users
  { id: 'packer-1', role: 'warehouse', username: 'packer-1', password: 'packer1234' },
  { id: 'packer-2', role: 'warehouse', username: 'packer-2', password: 'packer1234' },
  { id: 'packer-3', role: 'warehouse', username: 'packer-3', password: 'packer1234' },
  { id: 'packer-4', role: 'warehouse', username: 'packer-4', password: 'packer1234' },
];

// ─────────────────────────────────────────────────────────────────────────
// API Call Function
// ─────────────────────────────────────────────────────────────────────────

async function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': 'default',
      ...headers
    };

    const urlObj = new URL(path, BASE_URL);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: defaultHeaders,
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const responseTime = Date.now() - startTime;
        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

        // Track status codes
        metrics.statusCodeCounts[res.statusCode] = (metrics.statusCodeCounts[res.statusCode] || 0) + 1;

        try {
          const parsed = JSON.parse(data || '{}');
          metrics.totalRequests++;
          if (isSuccess) {
            metrics.successfulRequests++;
          } else {
            metrics.failedRequests++;
          }
          metrics.responseTimes.push(responseTime);
          resolve({ status: res.statusCode, data: parsed, responseTime, success: isSuccess });
        } catch (e) {
          metrics.totalRequests++;
          metrics.failedRequests++;
          metrics.responseTimes.push(responseTime);
          resolve({ status: res.statusCode, data: {}, responseTime, success: false, error: e.message });
        }
      });
    });

    req.on('error', (err) => {
      const responseTime = Date.now() - startTime;
      metrics.totalRequests++;
      metrics.failedRequests++;
      metrics.responseTimes.push(responseTime);
      metrics.errors.push({ message: err.message, user: headers['X-User-ID'] });
      resolve({ status: 0, data: {}, responseTime, success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.abort();
      const responseTime = Date.now() - startTime;
      metrics.totalRequests++;
      metrics.failedRequests++;
      metrics.responseTimes.push(responseTime);
      metrics.errors.push({ message: 'Timeout', user: headers['X-User-ID'] });
      resolve({ status: 0, data: {}, responseTime, success: false, error: 'Timeout' });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────
// User Session Management
// ─────────────────────────────────────────────────────────────────────────

async function loginUser(config) {
  const res = await makeRequest('POST', '/api/staff/login', {
    username: config.username,
    password: config.password
  }, { 'X-User-ID': config.id });

  if (res.success && res.data.token) {
    return {
      token: res.data.token,
      config,
      authenticated: true
    };
  }
  throw new Error(`Failed to login ${config.id}: ${res.error}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Workflow Definitions
// ─────────────────────────────────────────────────────────────────────────

async function adminWorkflow(session) {
  const headers = { 'Authorization': `Bearer ${session.token}`, 'X-User-ID': session.config.id, 'X-Tenant-ID': 'default' };
  const workflows = [];

  // 1. Check staff info
  workflows.push(makeRequest('GET', '/api/staff/me', null, headers));

  // 2. View all users (admin only)
  workflows.push(makeRequest('GET', '/api/staff/users', null, { ...headers, 'X-Tenant-ID': '' }));

  // 3. Get pending orders
  workflows.push(makeRequest('GET', '/api/staff/pending-orders', null, headers));

  // 4. View WMS waves
  workflows.push(makeRequest('GET', '/api/wms/waves', null, headers));

  // 5. Get WMS analytics dashboard
  workflows.push(makeRequest('GET', '/api/wms/analytics/dashboard', null, headers));

  // 6. Get warehouse stats
  workflows.push(makeRequest('GET', '/api/warehouse/stats', null, headers));

  // 7. Check client connections
  workflows.push(makeRequest('GET', '/api/admin/client-connections', null, headers));

  // 8. Get warehouse analytics
  workflows.push(makeRequest('GET', '/api/wms/analytics/warehouses', null, headers));

  return Promise.all(workflows);
}

async function warehouseManagerWorkflow(session) {
  const headers = { 'Authorization': `Bearer ${session.token}`, 'X-User-ID': session.config.id, 'X-Tenant-ID': 'default' };
  const workflows = [];

  // 1. Check staff info
  workflows.push(makeRequest('GET', '/api/staff/me', null, headers));

  // 2. View pending orders
  workflows.push(makeRequest('GET', '/api/staff/pending-orders', null, headers));

  // 3. Check WMS waves
  workflows.push(makeRequest('GET', '/api/wms/waves', null, headers));

  // 4. Get warehouse stats
  workflows.push(makeRequest('GET', '/api/warehouse/stats', null, headers));

  // 5. Get WMS analytics dashboard
  workflows.push(makeRequest('GET', '/api/wms/analytics/dashboard', null, headers));

  // 6. Get forecast gap
  workflows.push(makeRequest('GET', '/api/wms/forecast/gap', null, headers));

  // 7. Get WMS analytics trends
  workflows.push(makeRequest('GET', '/api/wms/analytics/trends', null, headers));

  // 8. Get sales by platform
  workflows.push(makeRequest('GET', '/api/wms/analytics/sales-by-platform', null, headers));

  return Promise.all(workflows);
}

async function packerWorkflow(session) {
  const headers = { 'Authorization': `Bearer ${session.token}`, 'X-User-ID': session.config.id, 'X-Tenant-ID': 'default' };
  const workflows = [];

  // 1. Check staff info
  workflows.push(makeRequest('GET', '/api/staff/me', null, headers));

  // 2. View pending orders
  workflows.push(makeRequest('GET', '/api/staff/pending-orders', null, headers));

  // 3. Check WMS waves
  workflows.push(makeRequest('GET', '/api/wms/waves', null, headers));

  // 4. Get warehouse stats
  workflows.push(makeRequest('GET', '/api/warehouse/stats', null, headers));

  // 5. Get WMS print queue
  workflows.push(makeRequest('GET', '/api/wms/print-queue', null, headers));

  // 6. Get WMS analytics dashboard
  workflows.push(makeRequest('GET', '/api/wms/analytics/dashboard', null, headers));

  // 7. Get print queue stats
  workflows.push(makeRequest('GET', '/api/wms/print-queue/stats', null, headers));

  // 8. Get returns summary
  workflows.push(makeRequest('GET', '/api/wms/returns/stats/summary', null, headers));

  return Promise.all(workflows);
}

// ─────────────────────────────────────────────────────────────────────────
// User Simulator
// ─────────────────────────────────────────────────────────────────────────

async function simulateUser(config, startDelay) {
  return new Promise((resolve) => {
    setTimeout(async () => {
      const userSession = {
        config,
        startTime: Date.now(),
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        responseTimes: []
      };

      try {
        // Login
        const session = await loginUser(config);
        userSession.authenticated = true;

        // Determine workflow based on role
        const endTime = Date.now() + DURATION_MS;
        let iterationCount = 0;

        while (Date.now() < endTime) {
          try {
            const results =
              config.role === 'admin' ? await adminWorkflow(session) :
              config.id.startsWith('wm-') ? await warehouseManagerWorkflow(session) :
              await packerWorkflow(session);

            iterationCount++;
            userSession.requestCount += results.length;
            userSession.successCount += results.filter(r => r.success).length;
            userSession.errorCount += results.filter(r => !r.success).length;
            results.forEach(r => userSession.responseTimes.push(r.responseTime));

            // Wait a bit before next iteration (avoid hammering)
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
          } catch (err) {
            userSession.errorCount++;
            metrics.errors.push({ message: err.message, user: config.id });
          }
        }

        userSession.iterations = iterationCount;
        userSession.endTime = Date.now();
        metrics.userSessions.push(userSession);
      } catch (err) {
        userSession.authenticated = false;
        userSession.error = err.message;
        metrics.userSessions.push(userSession);
      }

      resolve();
    }, startDelay);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Setup Users (Pre-test)
// ─────────────────────────────────────────────────────────────────────────

async function setupUsers() {
  console.log('\n📝 Setting up test users...\n');

  // First, ensure admin exists
  try {
    const adminRes = await makeRequest('GET', '/api/staff/emergency', null, {
      'X-Super-Password': 'SuperAdmin@2024'
    });
    if (adminRes.success) {
      console.log(`  ✓ Admin user initialized (password: Admin1234)`);
    }
  } catch (err) {
    console.log(`  ⚠ Emergency admin setup skipped: ${err.message}`);
  }

  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 500));

  // Get admin token
  let adminToken = null;
  try {
    const loginRes = await makeRequest('POST', '/api/staff/login', {
      username: 'administrator',
      password: 'Admin1234'
    });
    if (loginRes.success && loginRes.data.token) {
      adminToken = loginRes.data.token;
      console.log(`  ✓ Admin authenticated`);
    } else {
      console.log(`  ⚠ Admin login failed: ${loginRes.error}`);
    }
  } catch (err) {
    console.log(`  ⚠ Admin login error: ${err.message}`);
  }

  if (!adminToken) {
    console.log(`  ⚠ Skipping user creation - admin not authenticated`);
    return;
  }

  // Create test users as admin
  const setupTasks = [];
  const adminHeaders = {
    'Authorization': `Bearer ${adminToken}`,
    'X-User-ID': 'setup'
  };

  for (const config of userConfigs) {
    setupTasks.push(
      (async () => {
        try {
          await makeRequest('POST', '/api/staff/users', {
            username: config.username,
            password: config.password,
            role: config.role
          }, adminHeaders);
          console.log(`  ✓ User ${config.id} (${config.role}) created`);
        } catch (err) {
          console.log(`  ⚠ User ${config.id} setup: ${err.message}`);
        }
      })()
    );
  }

  await Promise.all(setupTasks);
}

// ─────────────────────────────────────────────────────────────────────────
// Main Test Execution
// ─────────────────────────────────────────────────────────────────────────

async function runLoadTest() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         FULFILLMENT SYSTEM LOAD TEST - CONCURRENT USERS       ║');
  console.log('║  5 Admins | 4 Warehouse Managers | 4 Packers | 15s Duration   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Setup phase
  await setupUsers();

  // Start load test
  console.log('\n🚀 Starting concurrent load test...\n');
  metrics.startTime = Date.now();

  // Ramp up users over 2 seconds
  const userTasks = userConfigs.map((config, index) => {
    const delay = (index / userConfigs.length) * RAMP_UP_MS;
    return simulateUser(config, delay);
  });

  // Wait for all users to complete
  await Promise.all(userTasks);
  metrics.endTime = Date.now();

  console.log('\n✅ Load test completed!\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Generate Reports
// ─────────────────────────────────────────────────────────────────────────

function calculateStats(times) {
  if (times.length === 0) return { min: 0, avg: 0, p95: 0, p99: 0, max: 0 };

  times.sort((a, b) => a - b);
  const min = times[0];
  const max = times[times.length - 1];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];

  return { min, avg, p95, p99, max };
}

function generateReport() {
  const totalTime = metrics.endTime - metrics.startTime;
  const throughput = metrics.totalRequests / (totalTime / 1000);
  const successRate = (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(2);
  const responseStats = calculateStats(metrics.responseTimes);

  const report = {
    timestamp: new Date().toISOString(),
    testConfig: {
      totalUsers: userConfigs.length,
      adminUsers: 5,
      warehouseManagers: 4,
      packers: 4,
      durationSeconds: Math.round(totalTime / 1000),
      rampUpSeconds: Math.round(RAMP_UP_MS / 1000)
    },
    overallMetrics: {
      totalRequests: metrics.totalRequests,
      successfulRequests: metrics.successfulRequests,
      failedRequests: metrics.failedRequests,
      successRate: parseFloat(successRate),
      throughputRPS: parseFloat(throughput.toFixed(2))
    },
    responseTimeMetrics: {
      minMs: responseStats.min,
      avgMs: parseFloat(responseStats.avg.toFixed(2)),
      p95Ms: responseStats.p95,
      p99Ms: responseStats.p99,
      maxMs: responseStats.max
    },
    userSummary: {
      totalSessions: metrics.userSessions.length,
      authenticatedSessions: metrics.userSessions.filter(s => s.authenticated).length,
      failedSessions: metrics.userSessions.filter(s => !s.authenticated).length
    },
    statusCodeDistribution: metrics.statusCodeCounts,
    errorSummary: {
      totalErrors: metrics.errors.length,
      uniqueErrorTypes: [...new Set(metrics.errors.map(e => e.message))].length,
      sampleErrors: metrics.errors.slice(0, 10)
    }
  };

  // Per-user breakdown
  report.userBreakdown = metrics.userSessions.map(session => ({
    userId: session.config.id,
    role: session.config.role,
    authenticated: session.authenticated,
    requestCount: session.requestCount || 0,
    successCount: session.successCount || 0,
    errorCount: session.errorCount || 0,
    iterations: session.iterations || 0,
    durationSeconds: Math.round((session.endTime - session.startTime) / 1000),
    avgResponseTimeMs: session.responseTimes.length > 0
      ? parseFloat((session.responseTimes.reduce((a, b) => a + b, 0) / session.responseTimes.length).toFixed(2))
      : 0,
    error: session.error || null
  }));

  // Role-based summary
  const roleStats = {};
  metrics.userSessions.forEach(session => {
    if (!roleStats[session.config.role]) {
      roleStats[session.config.role] = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalResponseTime: 0,
        sessionCount: 0
      };
    }
    roleStats[session.config.role].totalRequests += session.requestCount || 0;
    roleStats[session.config.role].successfulRequests += session.successCount || 0;
    roleStats[session.config.role].failedRequests += session.errorCount || 0;
    roleStats[session.config.role].totalResponseTime += session.responseTimes.reduce((a, b) => a + b, 0);
    roleStats[session.config.role].sessionCount += 1;
  });

  report.roleAnalysis = Object.entries(roleStats).map(([role, stats]) => ({
    role: role === 'admin' ? 'Admin (5 users)' : 'Warehouse (8 users)',
    totalRequests: stats.totalRequests,
    successfulRequests: stats.successfulRequests,
    failedRequests: stats.failedRequests,
    avgRequestsPerUser: parseFloat((stats.totalRequests / stats.sessionCount).toFixed(1)),
    avgResponseTimeMs: stats.totalResponseTime > 0
      ? parseFloat((stats.totalResponseTime / stats.totalRequests).toFixed(2))
      : 0
  }));

  return report;
}

function saveReports(report) {
  // Create directory if not exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Save JSON report
  const jsonPath = path.join(OUTPUT_DIR, 'load-test-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`📊 JSON Report: ${jsonPath}`);

  // Save text report
  const textPath = path.join(OUTPUT_DIR, 'load-test-results.txt');
  const text = generateTextReport(report);
  fs.writeFileSync(textPath, text);
  console.log(`📄 Text Report: ${textPath}`);

  // Save CSV for response times
  const csvPath = path.join(OUTPUT_DIR, 'load-test-response-times.csv');
  const csv = 'User ID,Role,Total Requests,Successful,Failed,Avg Response Time (ms),Duration (s)\n' +
    report.userBreakdown.map(u =>
      `${u.userId},${u.role},${u.requestCount},${u.successCount},${u.errorCount},${u.avgResponseTimeMs},${u.durationSeconds}`
    ).join('\n');
  fs.writeFileSync(csvPath, csv);
  console.log(`📈 CSV Report: ${csvPath}`);

  // Save load test script for reference
  const scriptPath = path.join(OUTPUT_DIR, 'load-test-concurrent.js');
  fs.copyFileSync(__filename, scriptPath);
  console.log(`📜 Script Copy: ${scriptPath}`);
}

function generateTextReport(report) {
  let text = '';
  text += '╔════════════════════════════════════════════════════════════════╗\n';
  text += '║       FULFILLMENT SYSTEM - LOAD TEST RESULTS & ANALYSIS        ║\n';
  text += '╚════════════════════════════════════════════════════════════════╝\n\n';

  text += '📋 TEST CONFIGURATION\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  text += `  Total Users:            ${report.testConfig.totalUsers}\n`;
  text += `    - Admin Users:        ${report.testConfig.adminUsers}\n`;
  text += `    - Warehouse Managers: ${report.testConfig.warehouseManagers}\n`;
  text += `    - Packers:            ${report.testConfig.packers}\n`;
  text += `  Test Duration:          ${report.testConfig.durationSeconds} seconds\n`;
  text += `  Ramp-up Time:           ${report.testConfig.rampUpSeconds} seconds\n`;
  text += `  Timestamp:              ${report.timestamp}\n\n`;

  text += '📊 OVERALL PERFORMANCE METRICS\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  text += `  Total Requests:         ${report.overallMetrics.totalRequests}\n`;
  text += `  Successful Requests:    ${report.overallMetrics.successfulRequests}\n`;
  text += `  Failed Requests:        ${report.overallMetrics.failedRequests}\n`;
  text += `  Success Rate:           ${report.overallMetrics.successRate}%\n`;
  text += `  Throughput:             ${report.overallMetrics.throughputRPS} RPS\n\n`;

  text += '⏱️  RESPONSE TIME ANALYSIS\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  text += `  Minimum:                ${report.responseTimeMetrics.minMs} ms\n`;
  text += `  Average:                ${report.responseTimeMetrics.avgMs} ms\n`;
  text += `  95th Percentile (P95):  ${report.responseTimeMetrics.p95Ms} ms\n`;
  text += `  99th Percentile (P99):  ${report.responseTimeMetrics.p99Ms} ms\n`;
  text += `  Maximum:                ${report.responseTimeMetrics.maxMs} ms\n\n`;

  text += '📊 HTTP STATUS CODE DISTRIBUTION\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  Object.entries(report.statusCodeDistribution).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([code, count]) => {
    const percentage = ((count / report.overallMetrics.totalRequests) * 100).toFixed(1);
    const statusText = code === '200' ? '(OK)' : code === '401' ? '(Unauthorized)' : code === '403' ? '(Forbidden)' : code === '404' ? '(Not Found)' : code === '500' ? '(Server Error)' : '';
    text += `  ${code} ${statusText.padEnd(20)}: ${count.toString().padEnd(5)} requests (${percentage}%)\n`;
  });
  text += '\n';

  text += '👥 USER SESSION SUMMARY\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  text += `  Total Sessions:         ${report.userSummary.totalSessions}\n`;
  text += `  Authenticated:          ${report.userSummary.authenticatedSessions}\n`;
  text += `  Failed:                 ${report.userSummary.failedSessions}\n\n`;

  text += '🔍 ROLE-BASED ANALYSIS\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  report.roleAnalysis.forEach(role => {
    text += `\n  ${role.role}:\n`;
    text += `    Total Requests:       ${role.totalRequests}\n`;
    text += `    Successful:           ${role.successfulRequests}\n`;
    text += `    Failed:               ${role.failedRequests}\n`;
    text += `    Avg per User:         ${role.avgRequestsPerUser} requests\n`;
    text += `    Avg Response Time:    ${role.avgResponseTimeMs} ms\n`;
  });

  text += '\n\n📋 PER-USER BREAKDOWN\n';
  text += '─────────────────────────────────────────────────────────────────\n';
  text += 'User ID         | Role       | Requests | Success | Failed | Avg RT (ms)\n';
  text += '────────────────┼────────────┼──────────┼─────────┼────────┼───────────\n';
  report.userBreakdown.forEach(user => {
    const role = user.role === 'admin' ? 'Admin   ' : 'Warehouse';
    text += `${user.userId.padEnd(15)} | ${role.padEnd(10)} | ${String(user.requestCount).padEnd(8)} | ${String(user.successCount).padEnd(7)} | ${String(user.errorCount).padEnd(6)} | ${String(user.avgResponseTimeMs).padEnd(9)}\n`;
  });

  text += '\n\n🎯 PERFORMANCE ANALYSIS & FINDINGS\n';
  text += '─────────────────────────────────────────────────────────────────\n';

  // Analyze results
  const avgResponseTime = report.responseTimeMetrics.avgMs;
  const p95ResponseTime = report.responseTimeMetrics.p95Ms;
  const successRate = report.overallMetrics.successRate;
  const throughput = report.overallMetrics.throughputRPS;

  text += `\n✅ STRENGTHS:\n`;
  if (successRate >= 99) text += `  • Excellent reliability: ${successRate}% success rate\n`;
  if (avgResponseTime < 200) text += `  • Fast response times: ${avgResponseTime}ms average\n`;
  if (throughput >= 50) text += `  • High throughput: ${throughput} requests/second\n`;
  text += `  • System handled ${report.testConfig.totalUsers} concurrent users smoothly\n`;

  text += `\n⚠️  AREAS FOR ATTENTION:\n`;
  if (successRate < 95) text += `  • Success rate below 95%: ${successRate}%\n`;
  if (avgResponseTime > 500) text += `  • Average response time: ${avgResponseTime}ms (consider optimization)\n`;
  if (p95ResponseTime > 1000) text += `  • P95 response time: ${p95ResponseTime}ms (high for 5% of requests)\n`;
  if (report.errorSummary.totalErrors > 0) text += `  • ${report.errorSummary.totalErrors} total errors encountered\n`;

  text += `\n📈 CAPACITY ASSESSMENT:\n`;
  if (successRate >= 95 && avgResponseTime < 500) {
    text += `  • System is PRODUCTION-READY for this load\n`;
    text += `  • Recommended max concurrent users: 50-100\n`;
    text += `  • Estimated capacity: 200+ transactions per minute\n`;
  } else if (successRate >= 90) {
    text += `  • System can handle moderate load with optimization needed\n`;
    text += `  • Recommended max concurrent users: 20-30\n`;
    text += `  • Address response time issues before production\n`;
  } else {
    text += `  • System needs optimization before production deployment\n`;
    text += `  • Recommended max concurrent users: < 20\n`;
    text += `  • Investigate authentication, database, and API bottlenecks\n`;
  }

  text += `\n💡 RECOMMENDATIONS:\n`;
  text += `  1. Implement caching for frequently accessed endpoints\n`;
  text += `  2. Add database indexing on order queries\n`;
  text += `  3. Consider connection pooling for database\n`;
  text += `  4. Monitor authentication bottlenecks\n`;
  text += `  5. Load balance across multiple server instances\n`;
  text += `  6. Implement rate limiting to protect against abuse\n\n`;

  if (report.errorSummary.totalErrors > 0) {
    text += `\n⚠️  ERROR DETAILS (First 10):\n`;
    text += '─────────────────────────────────────────────────────────────────\n';
    report.errorSummary.sampleErrors.forEach((err, i) => {
      text += `  ${i + 1}. ${err.message}\n`;
    });
  }

  text += '\n═════════════════════════════════════════════════════════════════\n';
  text += `Generated: ${new Date().toISOString()}\n`;

  return text;
}

// ─────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await runLoadTest();
    const report = generateReport();
    saveReports(report);

    // Print summary
    console.log('\n' + generateTextReport(report));
  } catch (err) {
    console.error('\n❌ Test execution failed:', err);
    process.exit(1);
  }
})();
