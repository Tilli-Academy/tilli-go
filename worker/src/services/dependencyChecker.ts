import prisma from '../config/prisma';

interface BlockingTask {
  id: string;
  taskName: string;
  status: string;
}

interface DependencyCheckResult {
  executable: boolean;
  blockingTasks: BlockingTask[];
}

// A dependency is met when the task it waits for is Completed, or N/A (not needed in
// this cutover). Same rule as backend/src/types/task.ts DONE_STATUSES.
export const DONE_STATUSES: ReadonlySet<string> = new Set(['Completed', 'N/A']);

export async function canTaskExecute(taskId: string): Promise<DependencyCheckResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const dependencies = await prisma.taskDependency.findMany({
    where: { taskId },
    include: {
      dependsOn: {
        select: { id: true, taskName: true, status: true, projectId: true },
      },
    },
  });

  if (dependencies.length === 0) {
    return { executable: true, blockingTasks: [] };
  }

  // Validate all dependencies are within the same project
  for (const dep of dependencies) {
    if (dep.dependsOn.projectId !== task.projectId) {
      throw new Error('Cross-project dependencies are not allowed');
    }
  }

  const blockingTasks = dependencies
    .filter((dep) => !DONE_STATUSES.has(dep.dependsOn.status))
    .map((dep) => ({
      id: dep.dependsOn.id,
      taskName: dep.dependsOn.taskName,
      status: dep.dependsOn.status,
    }));

  return {
    executable: blockingTasks.length === 0,
    blockingTasks,
  };
}
