import json
import os

from backend.services.security_service import get_safe_path


def list_workflows(workflows_dir):
    os.makedirs(workflows_dir, exist_ok=True)
    return sorted(filename[:-5] for filename in os.listdir(workflows_dir) if filename.endswith('.json'))


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
    with open(filepath, 'wb') as file:
        file.write(body)


def rename_workflow(old_name, new_name):
    old_path = get_safe_path(old_name)
    new_path = get_safe_path(new_name)
    if not old_path or not new_path or not os.path.exists(old_path):
        return False
    if os.path.exists(new_path):
        raise FileExistsError('Workflow already exists')
    os.rename(old_path, new_path)
    return True


def delete_workflow(name):
    filepath = get_safe_path(name)
    if not filepath or not os.path.exists(filepath):
        return False
    os.remove(filepath)
    return True


def clear_workflows(workflows_dir):
    os.makedirs(workflows_dir, exist_ok=True)
    deleted = 0
    for filename in os.listdir(workflows_dir):
        if not filename.endswith('.json'):
            continue
        filepath = os.path.join(workflows_dir, filename)
        if not os.path.isfile(filepath):
            continue
        os.remove(filepath)
        deleted += 1
    return deleted

"""封装工作流文件的保存、读取、重命名和删除操作。"""
