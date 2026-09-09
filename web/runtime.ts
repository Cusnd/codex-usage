export const exampleMode = import.meta.env?.MODE === 'showcase';
// All relative ranges use one clock, including rolling React Query requests.
export const currentTime = () => exampleMode ? Date.parse('2026-09-08T18:00:00.000Z') : Date.now();
