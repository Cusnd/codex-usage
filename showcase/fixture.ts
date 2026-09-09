// Deterministic synthetic records only. Never populated from a personal instance.
export const EXAMPLE_NOW = '2026-09-08T18:00:00.000Z';
export interface SeedStore {
  run(sql: string, params?: (string | number | null)[]): unknown;
  transaction(fn: () => void): void;
}
export function seedExample(store: SeedStore) {
const projectNames = ["codex-usage", "demo-api", "sample-notes", "playground"];
const projects = projectNames.map((name) => `c:\\design\\${name}`);
const projectTotals = [48_600_000, 35_200_000, 21_410_000, 14_000_000];
const daily = [
  8_200_000, 12_500_000, 18_400_000, 31_400_000, 16_200_000, 14_010_000,
  18_500_000,
];
const capacity = [...daily];
let eventIndex = 0,
  sessionIndex = 0,
  turnIndex = 0;
function emit(
  thread: string,
  turn: string,
  project: string,
  model: string,
  total: number,
  output: number,
  day: number,
  minute = 0,
) {
  const input = total - output,
    cached = Math.floor(input * 0.95);
  const at = `2026-09-${String(day + 2).padStart(2, "0")}T${String(5 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
  store.run(
    `INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,signature,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,incomplete,excluded,active) VALUES(?,?,?,?,?,?,?,?,?,'record',NULL,?,?,0,?,?,?,0,0,1)`,
    [
      "example",
      `event-${eventIndex}`,
      thread,
      turn,
      `response-${eventIndex++}`,
      at,
      project,
      model,
      model === "gpt-6-astra" ? "high" : "medium",
      input,
      cached,
      output,
      Math.floor(output / 5),
      total,
    ],
  );
  capacity[day] -= total;
}
store.transaction(() => {
  for (let project = 0; project < 4; project++) {
    const count = project === 0 ? 4 : 8;
    const totals =
      project === 0
        ? [18_200_000, 12_600_000, 8_400_000, 9_400_000]
        : Array.from(
            { length: count },
            (_, index) =>
              Math.floor(projectTotals[project] / count) +
              (index === count - 1 ? projectTotals[project] % count : 0),
          );
    for (let local = 0; local < count; local++) {
      const id = `example-session-${String(++sessionIndex).padStart(2, "0")}`;
      const title =
        project === 0
          ? [
              "Build usage dashboard",
              "Import session records",
              "Review query API",
              "Validate token totals",
            ][local]
          : `${["", "接口与文档", "学习笔记", "示例项目"][project]} · ${local + 1}`;
      store.run(
        "INSERT INTO threads(id,project,title,title_updated_at) VALUES(?,?,?,?)",
        [id, projects[project], title, "2026-09-08T04:00:00Z"],
      );
      if (sessionIndex === 1) {
        const totals = [
          3_600_000, 2_800_000, 4_200_000, 3_100_000, 2_500_000, 2_000_000,
        ];
        const outputs = [60_000, 60_000, 80_000, 80_000, 60_000, 60_000];
        totals.forEach((total, index) => {
          const turn = `turn-${String(index + 1).padStart(2, "0")}`;
          turnIndex++;
          if (index === 2) {
            emit(
              id,
              turn,
              projects[project],
              "gpt-6-astra",
              3_200_000,
              60_000,
              6,
              index * 18,
            );
            emit(
              id,
              turn,
              projects[project],
              "gpt-5.6-sol",
              1_000_000,
              20_000,
              6,
              index * 18 + 1,
            );
          } else
            emit(
              id,
              turn,
              projects[project],
              index < 4 ? "gpt-6-astra" : "gpt-5.6-sol",
              total,
              outputs[index],
              6,
              index * 18,
            );
        });
      } else {
        const turns = sessionIndex <= 6 ? 4 : 3;
        for (let t = 0; t < turns; t++) {
          const turn = `turn-${String(t + 1).padStart(2, "0")}`;
          turnIndex++;
          let remaining =
            Math.floor(totals[local] / turns) +
            (t === turns - 1 ? totals[local] % turns : 0);
          for (let day = 0; day < capacity.length && remaining > 0; day++) {
            const amount = Math.min(remaining, capacity[day]);
            if (amount <= 0) continue;
            emit(
              id,
              turn,
              projects[project],
              sessionIndex % 4 === 0 ? "gpt-5.6-sol" : "gpt-6-astra",
              amount,
              Math.floor(amount / 150),
              day,
              (eventIndex * 13) % 180,
            );
            remaining -= amount;
          }
          if (remaining !== 0) throw new Error("Invalid fixture allocation");
        }
      }
    }
  }
});
// Two direct children and one nested child, reusing the existing usage records.
for (const [child, parent] of [
  [2, 1],
  [3, 1],
  [4, 2],
]) {
  store.run("UPDATE threads SET subagent_parent_id=? WHERE id=?", [
    `example-session-${String(parent).padStart(2, "0")}`,
    `example-session-${String(child).padStart(2, "0")}`,
  ]);
}

}
