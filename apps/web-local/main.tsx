import { mountApplication } from '../../modules/web/shell/mount.js';
import { createWebRuntime, WebRuntimeProvider } from '../../modules/web/runtime/context.js';
import { localDataSource } from '../../modules/web/adapters/local.js';
import { deferredPages } from '../../modules/web/shell/deferred-pages.js';
const runtime = createWebRuntime(localDataSource);
mountApplication(children => <WebRuntimeProvider runtime={runtime}>{children}</WebRuntimeProvider>, deferredPages);
