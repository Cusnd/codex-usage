import { mountApplication } from '../../modules/web/shell/mount.js';
import { createWebRuntime, WebRuntimeProvider } from '../../modules/web/runtime/context.js';
import { exampleDataSource } from './data-source.js';
import { EXAMPLE_NOW } from './fixture.js';
import { deferredPages } from '../../modules/web/shell/deferred-pages.js';
const runtime = createWebRuntime(exampleDataSource, { demoPreview: true }, () => Date.parse(EXAMPLE_NOW));
mountApplication(children => <WebRuntimeProvider runtime={runtime}>{children}</WebRuntimeProvider>, deferredPages);
