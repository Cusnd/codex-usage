import { mountApplication } from '../../modules/web/shell/mount.js';
import { createWebRuntime, WebRuntimeProvider } from '../../modules/web/runtime/context.js';
import { localDataSource } from '../../modules/web/adapters/local.js';
const runtime = createWebRuntime(localDataSource);
mountApplication(children => <WebRuntimeProvider runtime={runtime}>{children}</WebRuntimeProvider>);
