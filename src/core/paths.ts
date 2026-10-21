import path from 'node:path';
import { DATA_DIR_NAME } from './constants.js';

export interface DataPaths {
  projectRoot: string;
  dataDir: string;
  storeDb: string;
  authDb: string;
  config: string;
  departments: string;
  priorities: string;
  exportsDir: string;
  lockFile: string;
  qrPng: string;
  logFile: string;
}

export function resolvePaths(projectRoot: string = process.cwd()): DataPaths {
  const root = path.resolve(projectRoot);
  const dataDir = path.join(root, DATA_DIR_NAME);
  return {
    projectRoot: root,
    dataDir,
    storeDb: path.join(dataDir, 'store.db'),
    authDb: path.join(dataDir, 'auth.db'),
    config: path.join(dataDir, 'config.yaml'),
    departments: path.join(dataDir, 'departments.yaml'),
    priorities: path.join(dataDir, 'priorities.yaml'),
    exportsDir: path.join(dataDir, 'exports'),
    lockFile: path.join(dataDir, 'daemon.lock'),
    qrPng: path.join(dataDir, 'qr.png'),
    logFile: path.join(dataDir, 'daemon.log'),
  };
}
