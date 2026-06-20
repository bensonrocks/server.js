const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { uploadFile } = require('../lib/storage');
const { suggestRooms } = require('../lib/visionRooms');
const { generateQuotePdf } = require('../lib/quotePdf');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const clientWithRooms = {
  rooms: {
    orderBy: { order: 'asc' },
    include: { furniture: { orderBy: { createdAt: 'asc' } } },
  },
};

router.get('/', async (req, res) => {
  const clients = await prisma.client.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(clients);
});

router.post('/', async (req, res) => {
  const { name, address, particulars } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  const client = await prisma.client.create({
    data: { name: name.trim(), address: address || null, particulars: particulars || null },
  });
  res.status(201).json(client);
});

router.get('/:id', async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id }, include: clientWithRooms });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

router.patch('/:id', async (req, res) => {
  const { name, address, particulars } = req.body;
  const client = await prisma.client.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(particulars !== undefined ? { particulars } : {}),
    },
  });
  res.json(client);
});

router.delete('/:id', async (req, res) => {
  await prisma.client.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// Upload + AI-interpret a floor plan: stores the image and returns suggested room names.
router.post('/:id/floorplan', upload.single('floorPlan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'floorPlan file is required' });

  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const floorPlanUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'floorplans');
  await prisma.client.update({ where: { id: client.id }, data: { floorPlanUrl } });

  let suggestedRooms = [];
  try {
    suggestedRooms = await suggestRooms(req.file.buffer, req.file.mimetype);
  } catch (err) {
    return res.status(207).json({
      floorPlanUrl,
      suggestedRooms: [],
      warning: `Floor plan saved, but AI room detection failed: ${err.message}`,
    });
  }

  res.json({ floorPlanUrl, suggestedRooms });
});

router.get('/:id/quote.pdf', async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id }, include: clientWithRooms });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${client.name.replace(/[^a-z0-9]+/gi, '-')}-quote.pdf"`);
  await generateQuotePdf(client, res);
});

module.exports = router;
