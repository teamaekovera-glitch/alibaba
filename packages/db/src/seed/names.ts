/**
 * Deterministic name banks for the fictional seed: supplier and buyer org
 * names plus per-category listing titles. All combinations are chosen by
 * index arithmetic (no RNG) so names are unique and reproducible.
 */

export const SUPPLIER_SUFFIXES = [
  "Packaging",
  "Container Co.",
  "Converting",
  "Plastics",
  "Pack Corp.",
  "Group",
] as const;

export const SUPPLIER_ROOTS = [
  "Summit", "Crestline", "Orion", "Harborview", "Meridian", "Lakeshore", "Vanguard",
  "Pinnacle", "Bluegrass", "Copperfield", "Stonebridge", "Fairwind", "Northstar",
  "Redstone", "Silvercreek", "Trueline", "Waypoint", "Juniper", "Cascadia", "Dunmore",
  "Elmwood", "Foxfield", "Glenview", "Hartwell", "Ironwood",
] as const;

export const BUYER_NAMES = [
  "Harbor & Vine", "Golden Acre Foods", "Willow Creek Beverages", "Copper Kettle Co.",
  "Sage & Stone Provisions", "Bluebird Snacks", "Prairie Row Kombucha", "Cedar Lane Dairy",
  "Wildflower Provisions", "Iron Peak Roasters", "Sunray Citrus Co.", "Maple Hollow Sauces",
  "Fernbrook Granola", "Driftwood Coffee", "Cloverfield Beverages", "Amber Grove Oils",
  "Northgate Salsas", "Silver Birch Bakery", "Tidewater Seafood Co.", "Juniper Springs Water",
  "Red Barn Condiments", "Foxglove Tea Co.", "Quarry Mill Pasta", "Larkspur Honey",
  "Cascadia Nut Butters", "Bellhaven Beverages", "Meadowbrook Cheese", "Stonewall Jerky",
  "Pine & Pearl Provisions", "Hearthstone Baking", "Riverstone Juices", "Gladestone Farms",
  "Windmere Pickles", "Oak & Ivy Brewing", "Saltmarsh Canning", "Verdant Valley Dairy",
  "Hawthorne Condiments", "Blue Ridge Beverages", "Fairfield Fruits", "Longfield Lakes",
] as const;

export const BUYER_CITIES: { city: string; state: string }[] = [
  { city: "Brooklyn", state: "NY" }, { city: "Austin", state: "TX" },
  { city: "San Diego", state: "CA" }, { city: "Seattle", state: "WA" },
  { city: "Boulder", state: "CO" }, { city: "Burlington", state: "VT" },
  { city: "Asheville", state: "NC" }, { city: "Portland", state: "ME" },
  { city: "Madison", state: "WI" }, { city: "Ann Arbor", state: "MI" },
] as const;

/** Buyer-founder style names for the seeded User rows (one per buyer org). */
export const BUYER_USER_NAMES = [
  "Ava Lindqvist", "Noah Berger", "Priya Raman", "Diego Fuentes", "Mei Watanabe",
  "Owen Callahan", "Zara Okafor", "Luca Moretti", "Ingrid Halvorsen", "Mateo Silva",
  "Freya Andersen", "Ravi Chandran", "Elise Dubois", "Tomás Herrera", "Nadia Karim",
  "Jonas Weber", "Sofia Ricci", "Amara Diallo", "Erik Johansson", "Leila Haddad",
  "Marcus Bell", "Hana Sato", "Oscar Lindgren", "Rosa Delgado", "Kai Nakamura",
  "Clara Whitfield", "Devon Price", "Yuki Tanaka", "Bianca Rossi", "Omar Farouk",
  "Greta Hoffman", "Felix Nordin", "Iris Connolly", "Dante Rossi", "Maya Goldberg",
  "Theo Lambert", "Nina Petrova", "Caleb Brooks", "Astrid Berg", "Hugo Marchand",
] as const;

// ── Listing titles ───────────────────────────────────────────────────────────

const CATEGORY_TITLES: Record<string, { shapes: string[]; materials: string[]; sizes: string[] }> = {
  rigid: {
    shapes: ["Cup", "Tub", "Bottle", "Jar", "Deli Container", "Clamshell"],
    materials: ["PP", "PET", "rPET", "PLA", "HDPE", "Glass"],
    sizes: ["8 oz", "16 oz", "32 oz", "12 oz", "24 oz", "64 oz"],
  },
  flexible: {
    shapes: ["Pouch", "Bag", "Sachet", "Film Roll", "Stick Pack", "Layflat Pouch"],
    materials: ["PE", "PET/PE", "Kraft/PE", "Metallized PET", "Compostable PLA"],
    sizes: ["100 g", "250 g", "500 g", "1 kg", "5 kg", "2 oz"],
  },
  corrugated: {
    shapes: ["Shipper Box", "Mailer", "Display Tray", "Bulk Bin", "Telescoping Box", "Divider Set"],
    materials: ["B-flute", "C-flute", "E-flute", "BC-flute", "Kraft", "White top"],
    sizes: ["12×9×4 in", "16×12×6 in", "18×14×8 in", "24×18×12 in", "8×8×8 in", "20×16×10 in"],
  },
  folding: {
    shapes: ["Folding Carton", "Sleeve", "End Load Box", "Reverse Tuck", "Two-Piece Box", "Gable Box"],
    materials: ["SBS 16pt", "Kraft 12pt", "CCNB 14pt", "Metalized board", "Recycled board"],
    sizes: ["3×3×1 in", "4×4×2 in", "6×4×2 in", "8×6×3 in", "5×5×5 in", "9×6×3 in"],
  },
  labels: {
    shapes: ["Pressure-Sensitive Label", "Shrink Sleeve", "Tag", "Sticker Sheet", "In-Mold Label", "Neck Label"],
    materials: ["BOPP", "Paper", "Clear PET", "Foil", "Textured estate"],
    sizes: ["2×2 in", "4×2 in", "3×3 in", "6×4 in", "1.5×1.5 in", "8×3 in"],
  },
  "cans-and-closures": {
    shapes: ["Can End", "Closure", "Pump Cap", "Flip-Top Cap", "Snap Cap", "Tamper Band"],
    materials: ["Aluminum", "Tinplate", "PP", "HDPE", "PCR resin"],
    sizes: ["202", "206", "300", "38 mm", "24 mm", "28 mm"],
  },
  "food-service": {
    shapes: ["Compostable Plate", "Bowl", "Cutlery Set", "Lidding Film", "Napkin", "Sushi Tray"],
    materials: ["Bagasse", "Bamboo", "PLA", "Paper", "CPLA"],
    sizes: ["9 in", "6 in", "12 in", "10 in", "16 oz", "24 oz"],
  },
  "shippers-and-protective": {
    shapes: ["Foam Insert", "Void Fill", "Insulated Liner", "Corner Protector", "Pallet Wrap", "Bubble Mailer"],
    materials: ["EPE foam", "Molded pulp", "Wool", "Air pillows", "Kraft honeycomb"],
    sizes: ["Small", "Medium", "Large", "XL", "Custom", "Standard"],
  },
  "sustainable-compostable": {
    shapes: ["Compostable Pouch", "Molded Fiber Tray", "Compostable Cup", "Fiber Bowl", "Bio Film", "Plantable Pot"],
    materials: ["PLA", "Bagasse", "Molded fiber", "PHB", "Kraft"],
    sizes: ["12 oz", "16 oz", "500 ml", "250 g", "8 in", "10 in"],
  },
};

const VARIANTS = ["", " — Clear", " — Kraft", " — Printed", " — Compostable", " — Recycled"] as const;

/**
 * Deterministic listing title for the i-th listing of a category family.
 * Cycles shapes × materials × sizes × variants so a supplier's eight
 * listings never collide.
 */
export function listingTitle(categorySlug: string, i: number): string {
  const bank = CATEGORY_TITLES[categorySlug];
  if (bank === undefined) throw new Error(`No title bank for category ${categorySlug}`);
  const shape = bank.shapes[i % bank.shapes.length];
  const material = bank.materials[Math.floor(i / bank.shapes.length) % bank.materials.length];
  const size = bank.sizes[Math.floor(i / (bank.shapes.length * bank.materials.length)) % bank.sizes.length];
  const variant =
    VARIANTS[
      Math.floor(i / (bank.shapes.length * bank.materials.length * bank.sizes.length)) % VARIANTS.length
    ];
  return `${size} ${material} ${shape}${variant}`;
}

/** Body copy for reviews, deterministic per order index. */
export const REVIEW_TITLES = [
  "Exactly what we needed", "Solid first order", "Great print quality",
  "Reliable turnaround", "Would order again", "Good value at volume",
  "Minor delay, great product", "Consistent quality",
] as const;

export const REVIEW_BODIES = [
  "Plates arrived on schedule and the print registration was spot on. Repacking line had no jams.",
  "MOQ pricing beat our previous vendor and the dieline review process was painless.",
  "Second reorder with identical specs — color match stayed within tolerance both times.",
  "Slight lead-time slip on the first batch, but the team kept us posted and the product is excellent.",
  "Cartons stack cleanly on our pallets and the corner crush test passed on the first try.",
  "Great communication through production; sample kit matched the final run exactly.",
  "Worked with their team on a custom compostable film. Quality is consistent across batches.",
  "Labels adhere well on chilled product. Repeat order already placed.",
] as const;
