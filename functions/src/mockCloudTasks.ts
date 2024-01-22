// Mock TaskQueue.enqueue implementation to support testing in an emulator
// Extended from: https://github.com/firebase/firebase-tools/issues/4884#issuecomment-1485075479

import { TaskQueue as FTaskQueue, TaskOptions } from "firebase-admin/functions";
import { logger } from "firebase-functions/v2";
import addintrooutrotaskhandler from "./addIntroOutro/addintrooutrotaskhandler";
import { TaskQueueFunction, Request } from "firebase-functions/v2/tasks";

declare interface TaskQueue {
    functionName: string;
    client: unknown;
    extensionId?: string;
    enqueue(data: Record<string, string>, opts?: TaskOptions): Promise<void>
}

if (process.env.FUNCTIONS_EMULATOR === 'true') {
    logger.log('Overriding enqueue functionality to work with local emulator')
    // Local Queue to run in the emulator
    // This queue is filled when the http call is invoked.
    let queue: { func: TaskQueueFunction, req: Request<any>, state: 'pending' | 'processing' | 'done', opts?: TaskOptions }[] = [];

    FTaskQueue.prototype.enqueue = function (this: TaskQueue, data: Record<string, string>, opts?: TaskOptions): Promise<void> {
        logger.debug("enqueueing", this.functionName, data, "task count", queue.length);

        return new Promise((resolve) => {
            if (this.functionName.endsWith('addintrooutrotaskhandler')) {
                logger.log("Adding addintrooutrotaskhandler to queue")
                queue.push({
                    func: addintrooutrotaskhandler,
                    req: { data },
                    state: 'pending',
                    opts
                });
                resolve();
            } else {
                resolve();
            }
        });
    };

    // Process the queue every second
    setInterval(async () => {
        // logger.debug("processing queue", queue.length);
        if (queue.length === 0) {
            return;
        };

        // Remove the latest done task.
        // This can be improved to get all done tasks.
        const taskDone = queue.findIndex(task => task.state === 'done');
        if (taskDone >= 0) {
            queue.splice(taskDone, 1);
        }

        // If a task is in processing, we can return early.
        // This may need more work to configure based on specific needs.
        const taskProcessing = queue.findIndex(task => task.state === 'processing');

        if (taskProcessing >= 0) {
            return;
        }

        // Get the first pending task
        const taskPending = queue.findIndex(task => task.state === 'pending');

        // If there are no pending tasks, return early
        if (taskPending === -1) {
            return;
        }

        // Get the function a      nd args for the pending task
        const { func, req } = queue[taskPending];
        // Set the task to `processing` state.
        queue[taskPending].state = 'processing';

        // Implementation dependant, my code always uses an Async function.
        try {
            // Run the task
            await func.run(req);
            queue[taskPending].state = 'done';
        } catch (err) {
            // If the task errors, set the state to `done`
            // Log the error
            logger.error("error processing task", err);
            queue[taskPending].state = 'done';
        }
    }, 1000);
}
