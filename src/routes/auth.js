const express = require('express');
const prisma = require('../lib/prisma');
const { hashPassword, verifyPassword } = require('../lib/auth');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.status(204).end();
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.session.userId, name: req.session.name, role: req.session.role });
});

// Admin-only staff account management.
router.get('/users', requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json(users);
});

router.post('/users', requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }
  if (role && !['ADMIN', 'STAFF'].includes(role)) {
    return res.status(400).json({ error: 'Role must be ADMIN or STAFF' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email: email.trim().toLowerCase(), passwordHash, name: name.trim(), role: role || 'STAFF' },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  res.status(201).json(user);
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await prisma.user.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
