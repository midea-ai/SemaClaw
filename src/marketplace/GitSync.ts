import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

export async function cloneOrPull(url: string, branch: string, localPath: string): Promise<void> {
  const isExistingRepo = fs.existsSync(path.join(localPath, '.git'));

  if (isExistingRepo) {
    const git = simpleGit(localPath);
    await git.fetch('origin');
    await git.checkout(branch);
    await git.pull('origin', branch);
  } else {
    if (fs.existsSync(localPath)) {
      await fs.promises.rm(localPath, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const git = simpleGit();
    await git.clone(url, localPath, ['--branch', branch, '--depth', '1']);
  }
}
