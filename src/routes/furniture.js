const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { uploadFile } = require('../lib/storage');
const { computeSellingPriceSgd } = require('../lib/pricing');
const { SUPPORTED_CURRENCIES } = require('../lib/exchangeRates');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/rooms/:roomId/furniture', upload.single('image'), async (req, res) => {
  const room = await prisma.room.findUnique({ where: { id: req.params.roomId } });
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { name, material, widthCm, depthCm, heightCm, costPrice, costCurrency } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Furniture name is required' });
  if (!costPrice || isNaN(Number(costPrice))) return res.status(400).json({ error: 'Numeric costPrice is required' });
  if (!SUPPORTED_CURRENCIES.includes(costCurrency)) {
    return res.status(400).json({ error: `costCurrency must be one of ${SUPPORTED_CURRENCIES.join(', ')}` });
  }

  let imageUrl = null;
  if (req.file) {
    imageUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'furniture');
  }

  const { exchangeRate, sellingPriceSgd } = await computeSellingPriceSgd(Number(costPrice), costCurrency);

  const furniture = await prisma.furniture.create({
    data: {
      roomId: room.id,
      name: name.trim(),
      imageUrl,
      material: material || null,
      widthCm: widthCm ? Number(widthCm) : null,
      depthCm: depthCm ? Number(depthCm) : null,
      heightCm: heightCm ? Number(heightCm) : null,
      costPrice: Number(costPrice),
      costCurrency,
      exchangeRate,
      sellingPriceSgd,
    },
  });

  res.status(201).json(furniture);
});

router.patch('/furniture/:id', upload.single('image'), async (req, res) => {
  const existing = await prisma.furniture.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Furniture not found' });

  const { name, material, widthCm, depthCm, heightCm, costPrice, costCurrency } = req.body;

  let imageUrl = existing.imageUrl;
  if (req.file) {
    imageUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'furniture');
  }

  const nextCostPrice = costPrice !== undefined ? Number(costPrice) : existing.costPrice;
  const nextCurrency = costCurrency !== undefined ? costCurrency : existing.costCurrency;
  if (!SUPPORTED_CURRENCIES.includes(nextCurrency)) {
    return res.status(400).json({ error: `costCurrency must be one of ${SUPPORTED_CURRENCIES.join(', ')}` });
  }

  const { exchangeRate, sellingPriceSgd } = await computeSellingPriceSgd(nextCostPrice, nextCurrency);

  const furniture = await prisma.furniture.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(material !== undefined ? { material } : {}),
      ...(widthCm !== undefined ? { widthCm: widthCm ? Number(widthCm) : null } : {}),
      ...(depthCm !== undefined ? { depthCm: depthCm ? Number(depthCm) : null } : {}),
      ...(heightCm !== undefined ? { heightCm: heightCm ? Number(heightCm) : null } : {}),
      imageUrl,
      costPrice: nextCostPrice,
      costCurrency: nextCurrency,
      exchangeRate,
      sellingPriceSgd,
    },
  });

  res.json(furniture);
});

router.delete('/furniture/:id', async (req, res) => {
  await prisma.furniture.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
