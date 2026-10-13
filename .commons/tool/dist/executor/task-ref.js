/** Local hosts retain their custom namespace; GitHub uses visible task branches. */
export const LOCAL_TASK_REF_PREFIX = "refs/tasks/";
export const GITHUB_TASK_REF_PREFIX = "refs/heads/commons/tasks/";
/** The git check-ref-format rules, without spawning git (also used for configured branch names). */
export function validRef(ref) {
    return ref.startsWith("refs/") &&
        !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
        !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".") &&
        ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
/** Build a task ref. Git validates it during fetch/push; error messages can always name it. */
export function taskRefFor(prefix = LOCAL_TASK_REF_PREFIX, taskId) {
    return `${prefix}${taskId}`;
}
//# sourceMappingURL=task-ref.js.map