import { mountApplication } from '../../modules/web/shell/mount.js';
import { CloudGate } from '../../modules/web/shell/cloud-gate.js';
import { eagerPages } from '../../modules/web/shell/eager-pages.js';

// Cloud pages must remain available when the user goes offline before visiting a route.
mountApplication(children => <CloudGate>{children}</CloudGate>, eagerPages);
