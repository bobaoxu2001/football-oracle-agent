import { persistKickoffCertaintyEnrichment } from "@/lib/competitions/premier-league/fixture-store";

const counts = persistKickoffCertaintyEnrichment();
console.log(JSON.stringify(counts, null, 2));
