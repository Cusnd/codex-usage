import { mountApplication } from '../../modules/web/shell/mount.js';
import { CloudGate } from '../../modules/web/shell/cloud-gate.js';
mountApplication(children => <CloudGate>{children}</CloudGate>);
