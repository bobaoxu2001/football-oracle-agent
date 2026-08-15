import { runAgent } from "@/lib/agent";

async function main() {
  const pl = await runAgent({ query: "Who wins Arsenal vs Liverpool?", persist: false });
  console.log("=== PL match ===");
  console.log("intent", pl.intent);
  console.log(pl.explanation);
  if (pl.prediction) {
    console.log({
      home: pl.prediction.teamAWin,
      draw: pl.prediction.draw,
      away: pl.prediction.teamBWin,
      expected: pl.prediction.expectedScore,
      score: pl.prediction.mostLikelyScore,
    });
  }

  const title = await runAgent({
    query: "Who is most likely to win the Premier League?",
    persist: false,
  });
  console.log("\n=== PL title ===");
  console.log("intent", title.intent);
  console.log(title.explanation.slice(0, 600));

  const wc = await runAgent({ query: "Who will win the World Cup?", persist: false });
  console.log("\n=== WC title ===");
  console.log("intent", wc.intent);
  console.log(wc.explanation.slice(0, 280));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
