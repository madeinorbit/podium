/**
 * THE SEAM POD-6962 REPLACES: WHO RUNS A FILE STORAGE JOB (POD-6963 design 2.9).
 *
 * The hourly upload sweeps and the daily orphan audit run in every server
 * process today, where the sweeps always ran. In a fleet each must run once,
 * which makes them lease-owned jobs under POD-6962. Until that exists they are
 * safe to run twice, in two processes or overlapping in one: every delete they
 * make is idempotent, and each judges only rows and keys a day old.
 *
 * This runner is the one place that decision lives. Today it runs the job,
 * skipping a start while the same job is still running in this process (an
 * audit of a large workspace can outlast an hour's tick). POD-6962 replaces
 * {@link FileStorageJobs.run}'s body with "run only while holding the job's
 * lease", and nothing else changes.
 */

/** The file storage jobs, by the name their lease will carry. */
export type FileStorageJobName = 'pending-upload-sweep' | 'artifact-upload-sweep' | 'orphan-audit'

export interface FileStorageJobs {
  /**
   * Run `job` unless the same job is running in this process. True when it
   * ran, false when it was skipped; a job's failure rejects.
   */
  run(name: FileStorageJobName, job: () => Promise<unknown>): Promise<boolean>
}

export function fileStorageJobs(): FileStorageJobs {
  const running = new Set<FileStorageJobName>()
  return {
    async run(name, job) {
      if (running.has(name)) return false
      running.add(name)
      try {
        await job()
        return true
      } finally {
        running.delete(name)
      }
    },
  }
}
