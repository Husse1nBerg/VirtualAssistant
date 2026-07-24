/**
 * Import / repair Hussein's contact roster into the Contact table.
 *
 * Idempotent: upserts by E.164 phone number, so re-running just corrects the
 * language / notes / VIP fields. Numbers are written as full +1514… E.164 so
 * they match Twilio's inbound `From` (normalizePhone only prepends `+`, it does
 * NOT add the country code — a bare 514… would store as +5148… and never match).
 *
 * Run against production:
 *   DATABASE_URL="<render-postgres-url>" npx tsx scripts/import-contacts.ts
 *
 * Run against local dev.db (safe dry-of-prod):
 *   npx tsx scripts/import-contacts.ts
 *
 * Pass --prune to also DELETE any existing contact not in this roster.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Row {
  name: string;
  phoneNumber: string; // full E.164
  language: 'en' | 'fr';
  isVip: boolean;
  notes?: string;
}

// isVip drives BOTH warm greeting tone AND high urgency scoring. Set true only for
// Hussein's explicit "score high" inner circle: parents, sisters, brother-in-law, best friend.
// Grandparents + friend's brother are contacts (name/language recognized) but not high-urgency.
const ROSTER: Row[] = [
  { name: 'Nadine Bayoun', phoneNumber: '+15148393917', language: 'en', isVip: true,  notes: 'Mother.' },
  { name: 'Abed Bayoun',   phoneNumber: '+15142430651', language: 'en', isVip: true,  notes: 'Father.' },
  { name: 'Ghada',         phoneNumber: '+15147578338', language: 'en', isVip: true,  notes: 'Sister. Name pronounced "RADA".' },
  { name: 'Yasmina',       phoneNumber: '+15145493840', language: 'en', isVip: true,  notes: 'Sister.' },
  { name: 'Julio',         phoneNumber: '+15145023726', language: 'fr', isVip: true,  notes: 'Brother-in-law. Speak French.' },
  { name: 'Faycal',        phoneNumber: '+15148626868', language: 'en', isVip: true,  notes: 'Best friend. Name pronounced "FAISSAL".' },
  { name: 'Karim',         phoneNumber: '+15142339340', language: 'en', isVip: false, notes: "Faycal's brother." },
  { name: 'Nada',          phoneNumber: '+15149288848', language: 'fr', isVip: false, notes: 'Grandmother (teta Nada). Speak French.' },
  { name: 'Issam',         phoneNumber: '+15149279713', language: 'fr', isVip: false, notes: 'Grandfather (jeddo Issam). Speak simple, clear French — he struggles with foreign languages.' },
];

async function main() {
  const prune = process.argv.includes('--prune');

  const before = await prisma.contact.findMany({ orderBy: { name: 'asc' } });
  console.log(`\nExisting contacts (${before.length}):`);
  for (const c of before) {
    console.log(`  ${c.phoneNumber.padEnd(14)} ${c.language.padEnd(3)} ${c.name}`);
  }

  const canonical = new Set(ROSTER.map((r) => r.phoneNumber));

  console.log('\nUpserting roster...');
  for (const r of ROSTER) {
    await prisma.contact.upsert({
      where: { phoneNumber: r.phoneNumber },
      update: { name: r.name, language: r.language, isVip: r.isVip, notes: r.notes ?? null },
      create: { phoneNumber: r.phoneNumber, name: r.name, language: r.language, isVip: r.isVip, notes: r.notes ?? null },
    });
    const flag = r.language === 'fr' ? '  <-- FRENCH' : '';
    console.log(`  ok  ${r.phoneNumber} ${r.language} ${r.name}${flag}`);
  }

  const strays = before.filter((c) => !canonical.has(c.phoneNumber));
  if (strays.length) {
    console.log(`\nContacts NOT in roster (${strays.length})${prune ? ' — pruning:' : ' — left in place (re-run with --prune to delete):'}`);
    for (const c of strays) {
      console.log(`  ${c.phoneNumber.padEnd(14)} ${c.language.padEnd(3)} ${c.name}`);
      if (prune) await prisma.contact.delete({ where: { id: c.id } });
    }
  }

  const after = await prisma.contact.findMany({ orderBy: { name: 'asc' } });
  const french = after.filter((c) => c.language === 'fr');
  console.log(`\nDone. ${after.length} contacts total, ${french.length} French: ${french.map((c) => c.name).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
