export const exampleMode = import.meta.env?.MODE === 'showcase';
export const cloudMode = import.meta.env?.MODE === 'cloud';
let cloudClock: (() => number) | undefined;
export function setCloudClock(clock?: () => number) { cloudClock = clock; }
// All relative ranges use one clock, including rolling React Query requests.
export const currentTime = () => exampleMode ? Date.parse('2026-09-08T18:00:00.000Z') : cloudMode && cloudClock ? cloudClock() : Date.now();
