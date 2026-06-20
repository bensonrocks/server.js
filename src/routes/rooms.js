const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

router.post('/clients/:clientId/rooms', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required' });

  const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const count = await prisma.room.count({ where: { clientId: client.id } });
  const room = await prisma.room.create({
    data: { clientId: client.id, name: name.trim(), order: count },
  });
  res.status(201).json(room);
});

router.patch('/rooms/:id', async (req, res) => {
  const { name, order } = req.body;
  const room = await prisma.room.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(order !== undefined ? { order } : {}),
    },
  });
  res.json(room);
});

router.delete('/rooms/:id', async (req, res) => {
  await prisma.room.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
