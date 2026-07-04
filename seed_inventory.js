'use strict';
// Seed ~500 sample inventory items into the default tenant DB
// Run from project root: node seed_inventory.js

const { getTenantDb } = require('./lib/db/tenant');
const createInventory  = require('./lib/inventory');

const db  = getTenantDb('default');
const inv = createInventory(db);

const dr  = (i, m) => ((i * 2654435761) >>> 0) % m;
const dp  = (i, m, off = 0) => (((i * 1664525 + 1013904223) >>> 0) % m) + off;
const pick = (i, arr) => arr[dr(i * 6007, arr.length)];

const ZONES   = ['A','B','C','D','E'];
const ROWS    = Array.from({length:12}, (_,i) => String(i+1).padStart(2,'0'));
const SHELVES = ['01','02','03','04','05','06'];
const BINS    = ['01','02','03','04'];
const locOf   = i => `Zone ${pick(i*3,ZONES)}-Row ${pick(i*7,ROWS)}-Shelf ${pick(i*11,SHELVES)}-Bin ${pick(i*13,BINS)}`;

const CLIENTS = [
  { pfx:'TVE', name:'TechVision Electronics' },
  { pfx:'SHF', name:'StyleHub Fashion'       },
  { pfx:'HCL', name:'HomeComfort Living'     },
  { pfx:'SPA', name:'SportsPro Athletics'    },
  { pfx:'BEX', name:'BeautyEssentials'       },
  { pfx:'KMC', name:'KitchenMaster Co.'      },
  { pfx:'ACH', name:'AutoCare Hub'           },
  { pfx:'PET', name:'PetParadise'            },
];

const CATALOGUE = [
  ['USB-C Hub 7-Port','Electronics','pcs',45.00,89.99,'Aluminium 7-port USB-C hub with 4K HDMI'],
  ['Wireless Mouse Ergonomic','Electronics','pcs',18.00,34.99,'Silent-click 2.4GHz wireless ergonomic mouse'],
  ['Mechanical Keyboard TKL','Electronics','pcs',55.00,110.00,'Tenkeyless mechanical keyboard, blue switches'],
  ['27in Monitor 4K IPS','Electronics','pcs',220.00,399.00,'27-inch 4K UHD IPS 144Hz HDR400 monitor'],
  ['Laptop Stand Adjustable','Electronics','pcs',22.00,49.99,'Aluminium foldable laptop stand up to 17in'],
  ['Webcam 1080p Auto-focus','Electronics','pcs',35.00,69.99,'Full HD webcam with autofocus & mic'],
  ['USB-C Cable 2m Braided','Electronics','pcs',4.50,12.99,'Braided 2m USB-A to USB-C fast charge cable'],
  ['Wireless Charging Pad 15W','Electronics','pcs',14.00,29.99,'Qi wireless charging pad 15W max'],
  ['Portable SSD 1TB','Electronics','pcs',65.00,119.00,'USB 3.2 Gen 2 portable SSD 1050 MB/s'],
  ['HDMI 2.1 Cable 3m','Electronics','pcs',8.00,19.99,'8K HDMI 2.1 cable 48Gbps bandwidth'],
  ['ANC Earbuds TWS','Electronics','pcs',42.00,89.00,'Active noise-cancel TWS earbuds 30h battery'],
  ['Smart Power Strip 4-USB','Electronics','pcs',19.00,39.99,'4-outlet smart strip with 4 USB ports'],
  ['LED Desk Lamp USB','Electronics','pcs',16.00,34.99,'LED desk lamp 5 brightness levels USB port'],
  ['Bluetooth Speaker IP67','Electronics','pcs',28.00,59.99,'Waterproof bluetooth speaker 24h play'],
  ['USB Cardioid Microphone','Electronics','pcs',38.00,79.00,'USB cardioid condenser mic for streaming'],
  ['GaN Charger 65W','Electronics','pcs',17.00,36.99,'GaN 65W USB-C PD wall charger foldable'],
  ['Privacy Screen 15.6in','Electronics','pcs',20.00,44.99,'15.6in laptop privacy screen filter 2-way'],
  ['Wireless KB+Mouse Kit','Electronics','set',32.00,65.99,'2.4GHz wireless keyboard and mouse combo'],
  ['Unisex Tee White S','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee white S'],
  ['Unisex Tee White M','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee white M'],
  ['Unisex Tee White L','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee white L'],
  ['Unisex Tee Black S','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee black S'],
  ['Unisex Tee Black M','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee black M'],
  ['Unisex Tee Black L','Apparel','pcs',4.00,14.99,'100% cotton classic fit tee black L'],
  ['Slim Chino Beige W30','Apparel','pcs',14.00,39.99,'Slim fit chino trousers beige W30 L32'],
  ['Slim Chino Navy W32','Apparel','pcs',14.00,39.99,'Slim fit chino trousers navy W32 L32'],
  ['Floral Wrap Dress M','Apparel','pcs',18.00,49.99,'Women floral wrap midi dress M'],
  ['Denim Jacket Washed L','Apparel','pcs',28.00,69.99,'Unisex washed blue denim jacket L'],
  ['Hoodie Grey Marl L','Apparel','pcs',16.00,39.99,'320g fleece hoodie grey marl L'],
  ['Ankle Socks 3-Pack','Apparel','set',3.50,9.99,'Cotton-blend ankle socks 3-pack'],
  ['Bamboo Cutting Board Lg','Home & Living','pcs',9.00,24.99,'Large bamboo cutting board 45x30cm'],
  ['Cotton Throw Blanket Grey','Home & Living','pcs',18.00,44.99,'Knitted cotton throw 130x150cm grey'],
  ['Ceramic Vase Set 3','Home & Living','set',12.00,32.99,'Set of 3 minimalist ceramic vases white'],
  ['Soy Candle Vanilla 200g','Home & Living','pcs',6.00,16.99,'Soy wax vanilla scented candle 200g'],
  ['Soy Candle Lavender 200g','Home & Living','pcs',6.00,16.99,'Soy wax lavender scented candle 200g'],
  ['Linen Duvet Cover King','Home & Living','pcs',35.00,89.99,'Stonewashed linen duvet cover king white'],
  ['Linen Duvet Cover Queen','Home & Living','pcs',28.00,72.99,'Stonewashed linen duvet cover queen white'],
  ['Seagrass Storage Basket Med','Home & Living','pcs',11.00,28.99,'Handwoven seagrass basket medium'],
  ['Velvet Cushion Cover Navy','Home & Living','pcs',7.00,18.99,'Velvet cushion cover 45x45cm navy'],
  ['Blackout Curtain Pair Grey','Home & Living','pair',22.00,54.99,'Thermal blackout curtains 140x240cm grey'],
  ['Floating Shelf Pine 60cm','Home & Living','pcs',9.00,23.99,'Pine wood floating wall shelf 60cm'],
  ['LED Fairy Lights USB 5m','Home & Living','pcs',5.50,14.99,'USB LED fairy lights warm white 5m'],
  ['Resistance Band Set 5Pc','Sports','set',8.00,22.99,'Latex resistance band set 5 levels'],
  ['Non-slip Yoga Mat 6mm','Sports','pcs',12.00,29.99,'TPE non-slip yoga mat 6mm 183x61cm'],
  ['Speed Jump Rope Cable','Sports','pcs',6.00,15.99,'Speed jump rope adjustable steel cable'],
  ['Foam Roller 30cm Grid','Sports','pcs',10.00,24.99,'EVA deep-tissue foam roller 30cm'],
  ['BPA-free Water Bottle 750ml','Sports','pcs',5.50,14.99,'Tritan sports bottle 750ml flip lid'],
  ['Padded Gym Gloves M','Sports','pcs',7.00,18.99,'Padded palm gym gloves full grip M'],
  ['Doorframe Pull-up Bar','Sports','pcs',18.00,44.99,'No-screw doorframe pull-up bar'],
  ['Ab Roller Dual Wheel','Sports','pcs',9.00,22.99,'Dual ab roller wheel with knee pad'],
  ['Kettlebell 12kg','Sports','pcs',22.00,49.99,'Cast iron kettlebell 12kg powder coated'],
  ['Kettlebell 16kg','Sports','pcs',28.00,62.99,'Cast iron kettlebell 16kg powder coated'],
  ['Gym Bag 40L Black','Sports','pcs',16.00,39.99,'Polyester gym bag 40L shoe compartment'],
  ['Percussion Massage Gun','Sports','pcs',45.00,99.00,'Percussion massage gun 6 heads rechargeable'],
  ['Vitamin C Serum 30ml','Beauty','pcs',12.00,29.99,'20% Vit C + E + ferulic acid brightening serum'],
  ['Hyaluronic Acid Serum 30ml','Beauty','pcs',10.00,24.99,'Pure 2% hyaluronic acid hydrating serum'],
  ['Retinol Night Cream 50ml','Beauty','pcs',14.00,34.99,'0.3% retinol night moisturiser'],
  ['SPF 50 Sunscreen 50ml','Beauty','pcs',8.00,19.99,'Lightweight SPF 50 PA++++ daily sunscreen'],
  ['Micellar Cleansing Water 400ml','Beauty','pcs',5.00,12.99,'Gentle micellar water all skin types'],
  ['Jade Face Roller','Beauty','pcs',9.00,22.99,'Natural jade face roller dual-ended'],
  ['Rose Quartz Gua Sha','Beauty','pcs',8.00,19.99,'Rose quartz gua sha facial massage stone'],
  ['Korean Sheet Mask Box 10Pc','Beauty','box',8.00,19.99,'Hydrating sheet mask variety box 10 pcs'],
  ['Vegan Makeup Brush Set 12Pc','Beauty','set',12.00,29.99,'12-piece vegan brush set with roll pouch'],
  ['Argan Hair Oil 100ml','Beauty','pcs',9.00,22.99,'Moroccan argan oil frizz control 100ml'],
  ['Cast Iron Skillet 26cm','Kitchen','pcs',28.00,64.99,'Pre-seasoned cast iron skillet 26cm'],
  ['Silicone Spatula Set 3Pc','Kitchen','set',5.50,13.99,'Heat-resistant silicone spatulas 3 sizes'],
  ['Digital Kitchen Scale 5kg','Kitchen','pcs',12.00,28.99,'Digital scale 5kg / 0.1g precision tare'],
  ['Glass Containers Set 5Pc','Kitchen','set',18.00,44.99,'Borosilicate glass meal prep containers 5pc'],
  ['Silicone Baking Mat 2-Pack','Kitchen','pack',10.00,24.99,'Non-stick silicone baking mat 33x23cm'],
  ['Magnetic Spice Rack 12 Jars','Kitchen','set',20.00,48.99,'Stainless magnetic spice rack 12 jars'],
  ['Granite Mortar & Pestle','Kitchen','pcs',16.00,38.99,'2-cup granite mortar and pestle'],
  ['Instant-Read Thermometer','Kitchen','pcs',10.00,24.99,'Digital instant-read thermometer -50 to 300C'],
  ['Reusable Silicone Bags 5Pk','Kitchen','set',14.00,34.99,'Leakproof silicone food bags 5-pack'],
  ['Adjustable Mandoline Slicer','Kitchen','pcs',18.00,42.99,'Adjustable mandoline slicer with guard'],
  ['Microfibre Car Wash Mitt','Auto Care','pcs',4.50,11.99,'Ultra-soft microfibre wash mitt scratch-free'],
  ['Clay Bar Kit 100g','Auto Care','pcs',8.00,19.99,'Auto detailing clay bar kit with lubricant'],
  ['Digital Tyre Pressure Gauge','Auto Care','pcs',6.00,14.99,'Digital tyre pressure gauge 0-100 PSI'],
  ['Magnetic Phone Mount 360','Auto Care','pcs',7.50,18.99,'Magnetic suction cup phone mount 360 deg'],
  ['Jump Starter 1500A 12V','Auto Care','pcs',42.00,89.00,'Compact jump starter pack 1500A 12V'],
  ['Back Seat Organiser 2-Pocket','Auto Care','pcs',8.00,19.99,'Back seat organiser 2 pockets neoprene'],
  ['Foldable Windshield Sunshade','Auto Care','pcs',6.50,15.99,'Accordion-fold aluminium sunshade universal'],
  ['Activated Charcoal Air Freshener','Auto Care','pcs',4.00,9.99,'Activated charcoal car air freshener bag'],
  ['Cordless Tyre Inflator 150PSI','Auto Care','pcs',18.00,39.99,'Cordless portable tyre inflator 150 PSI'],
  ['Silicone Steering Wheel Cover','Auto Care','pcs',9.00,21.99,'Universal silicone steering wheel cover'],
  ['Dog Harness No-Pull M','Pet Care','pcs',12.00,29.99,'Padded no-pull dog harness adjustable M'],
  ['Dog Harness No-Pull L','Pet Care','pcs',14.00,33.99,'Padded no-pull dog harness adjustable L'],
  ['Retractable Dog Leash 5m','Pet Care','pcs',9.00,22.99,'One-button retractable dog leash 5m 25kg'],
  ['Stainless Pet Bowl 500ml','Pet Care','pcs',4.50,11.99,'Stainless steel pet food/water bowl 500ml'],
  ['Stainless Pet Bowl 1.5L','Pet Care','pcs',6.00,14.99,'Stainless steel pet food/water bowl 1.5L'],
  ['Sisal Cat Scratch Post 60cm','Pet Care','pcs',10.00,24.99,'Sisal cat scratch post 60cm with base'],
  ['Interactive Feather Cat Wand','Pet Care','pcs',4.00,9.99,'Interactive telescopic feather cat wand'],
  ['Cat Self-Grooming Arch Brush','Pet Care','pcs',8.50,19.99,'Corner self-grooming arch brush for cats'],
  ['Orthopedic Pet Bed Large','Pet Care','pcs',22.00,52.99,'Memory foam orthopedic pet bed washable L'],
  ['Puppy Training Pads 50Pk','Pet Care','pack',8.00,18.99,'Absorbent training pads 60x60cm 50-pack'],
];

const items = [];
let seq = 1;

// Clear existing inventory first
inv.getAll().forEach(r => inv.remove(r.sku));

for (const { pfx, name: clientName } of CLIENTS) {
  for (let pi = 0; pi < CATALOGUE.length && items.length < 504; pi++) {
    const [prodName, category, unit, cost, sell, desc] = CATALOGUE[pi];
    const skuNum   = String(seq).padStart(4,'0');
    const sku      = `${pfx}-${skuNum}`;
    const stockQty = dp(seq * 17, 250, 3);
    items.push({
      sku,
      name:          prodName,
      category,
      location:      locOf(seq),
      unit,
      stock_qty:     stockQty,
      reserved_qty:  dr(seq * 29, Math.max(1, Math.floor(stockQty * 0.12))),
      reorder_point: dp(seq * 5, 20, 5),
      cost_price:    cost,
      sell_price:    sell,
      description:   `[${clientName}] ${desc}`,
    });
    seq++;
  }
}

console.log(`Generated ${items.length} items — importing into default tenant…`);

let imported = 0; const errors = [];
for (const item of items) {
  try { inv.upsert(item); imported++; }
  catch (e) { errors.push(`${item.sku}: ${e.message}`); }
}

console.log(`Done. Imported: ${imported}${errors.length ? ', Errors: ' + errors.length : ''}`);
if (errors.length) errors.slice(0,5).forEach(e => console.error(' ', e));
