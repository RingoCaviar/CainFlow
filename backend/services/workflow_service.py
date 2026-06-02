import os
import shutil

from backend import config
from backend.services.security_service import get_safe_folder_path, get_safe_path


def list_workflows(workflows_dir):
    os.makedirs(workflows_dir, exist_ok=True)
    workflows = []
    folders = []
    for root, dirnames, filenames in os.walk(workflows_dir):
        dirnames.sort()
        filenames.sort()
        rel_root = os.path.relpath(root, workflows_dir)
        if rel_root != '.':
            folders.append(rel_root.replace(os.sep, '/'))
        for filename in filenames:
            if not filename.endswith('.json'):
                continue
            rel_path = os.path.join(rel_root, filename[:-5]) if rel_root != '.' else filename[:-5]
            workflows.append(rel_path.replace(os.sep, '/'))
    return {'workflows': sorted(workflows), 'folders': sorted(folders)}


def _workflow_name_from_file(filepath):
    rel_path = os.path.relpath(filepath, config.WORKFLOWS_DIR)
    if not rel_path.endswith('.json'):
        return ''
    return rel_path[:-5].replace(os.sep, '/')


def _workflow_base_name(name):
    return str(name or '').split('/')[-1]


def _workflow_base_exists(base_name, exclude_names=None):
    exclude_names = set(exclude_names or [])
    workflows = list_workflows(config.WORKFLOWS_DIR).get('workflows', [])
    return any(
        workflow_name not in exclude_names
        and _workflow_base_name(workflow_name) == base_name
        for workflow_name in workflows
    )


def _collect_workflow_files_under(folderpath):
    workflows = []
    for root, _, filenames in os.walk(folderpath):
        for filename in sorted(filenames):
            if not filename.endswith('.json'):
                continue
            workflows.append(os.path.join(root, filename))
    return sorted(workflows, key=lambda filepath: _workflow_name_from_file(filepath))


def _get_unique_root_workflow_name(base_name, reserved_names=None, exclude_names=None):
    reserved_names = reserved_names or set()
    exclude_names = set(exclude_names or [])
    candidate = base_name
    index = 1
    while candidate in reserved_names or _workflow_base_exists(candidate, exclude_names=exclude_names):
        candidate = f'{base_name} {index}'
        index += 1
    return candidate


def load_workflow(name):
    filepath = get_safe_path(name)
    if not filepath or not os.path.exists(filepath):
        return None
    with open(filepath, 'rb') as file:
        return file.read()


def save_workflow(name, body):
    filepath = get_safe_path(name)
    if not filepath:
        raise ValueError('Invalid workflow name')
    if _workflow_base_exists(_workflow_base_name(name), exclude_names={name}):
        raise FileExistsError('Workflow name already exists')
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'wb') as file:
        file.write(body)


def rename_workflow(old_name, new_name):
    old_path = get_safe_path(old_name)
    new_path = get_safe_path(new_name)
    if not old_path or not new_path or not os.path.exists(old_path):
        return False
    if os.path.exists(new_path):
        raise FileExistsError('Workflow already exists')
    if _workflow_base_exists(_workflow_base_name(new_name), exclude_names={old_name}):
        raise FileExistsError('Workflow name already exists')
    os.makedirs(os.path.dirname(new_path), exist_ok=True)
    os.rename(old_path, new_path)
    return True


def delete_workflow(name):
    filepath = get_safe_path(name)
    if not filepath or not os.path.exists(filepath):
        return False
    os.remove(filepath)
    return True


def create_workflow_folder(name):
    folderpath = get_safe_folder_path(name)
    if not folderpath:
        raise ValueError('Invalid workflow folder name')
    os.makedirs(folderpath, exist_ok=True)
    return True


def rename_workflow_folder(old_name, new_name):
    old_folderpath = get_safe_folder_path(old_name)
    new_folderpath = get_safe_folder_path(new_name)
    if not old_folderpath or not new_folderpath or not os.path.isdir(old_folderpath):
        return None
    if os.path.exists(new_folderpath):
        raise FileExistsError('Workflow folder already exists')

    old_prefix = os.path.relpath(old_folderpath, config.WORKFLOWS_DIR).replace(os.sep, '/')
    new_prefix = os.path.relpath(new_folderpath, config.WORKFLOWS_DIR).replace(os.sep, '/')
    moved = []
    for filepath in _collect_workflow_files_under(old_folderpath):
        old_workflow_name = _workflow_name_from_file(filepath)
        suffix = old_workflow_name[len(old_prefix):].lstrip('/')
        moved.append({'old': old_workflow_name, 'new': f'{new_prefix}/{suffix}'})

    os.makedirs(os.path.dirname(new_folderpath), exist_ok=True)
    os.rename(old_folderpath, new_folderpath)
    return {'moved': moved}


def delete_workflow_folder(name, delete_contents=False):
    folderpath = get_safe_folder_path(name)
    if not folderpath or not os.path.isdir(folderpath):
        return None

    workflow_files = _collect_workflow_files_under(folderpath)
    workflow_names = [_workflow_name_from_file(filepath) for filepath in workflow_files]
    if delete_contents:
        shutil.rmtree(folderpath)
        return {'deleted': workflow_names, 'moved': []}

    moved = []
    reserved_names = set()
    for old_name in workflow_names:
        old_path = get_safe_path(old_name)
        base_name = old_name.split('/')[-1]
        new_name = _get_unique_root_workflow_name(base_name, reserved_names, exclude_names={old_name})
        new_path = get_safe_path(new_name)
        if not old_path or not new_path:
            raise ValueError('Invalid workflow folder content')
        os.rename(old_path, new_path)
        reserved_names.add(new_name)
        moved.append({'old': old_name, 'new': new_name})

    shutil.rmtree(folderpath)
    return {'deleted': [], 'moved': moved}


def clear_workflows(workflows_dir):
    os.makedirs(workflows_dir, exist_ok=True)
    deleted = 0
    for root, _, filenames in os.walk(workflows_dir):
        for filename in filenames:
            if not filename.endswith('.json'):
                continue
            filepath = os.path.join(root, filename)
            if not os.path.isfile(filepath):
                continue
            os.remove(filepath)
            deleted += 1
    return deleted


"""封装工作流文件的保存、读取、重命名和删除操作。"""
