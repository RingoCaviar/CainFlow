# CainFlow

CainFlow is a visual workspace for composing and running media-generation workflows. This glossary defines the shared language for the Prompt Agent and its workflow-bound creative context.

## Prompt Agent

**Prompt Agent**:
A lightweight assistant that turns a creator's natural-language image request into an image-generation prompt and can apply the result to the selected image-generation node.
_Avoid_: autonomous agent, workflow orchestrator

**Creative Context**:
The implicit, workflow-scoped understanding of the creator's current subject, style, constraints, and prior direction used to keep prompt revisions coherent.
_Avoid_: user profile, global memory

**Image-Generation Node**:
A canvas node that represents an image-generation or image-editing request and owns the prompt and generation parameters for that request.
_Avoid_: image task, prompt node

**Prompt Plan**:
The proposed prompt, negative prompt, and generation parameters produced by the Prompt Agent before they are applied to an image-generation node.
_Avoid_: agent answer, generation result

**Workflow Memory**:
The compressed creative context associated with one workflow and restored when that workflow is reopened; it is cleared when a new workflow is created.
_Avoid_: long-term memory, user memory, chat history

**Agent Work Summary**:
A concise, collapsible account of the Prompt Agent's observable work stages, such as reading the selected node and preparing a Prompt Plan; it is not a transcript of private model reasoning.
_Avoid_: chain of thought, hidden reasoning

**Agent Conversation**:
The Prompt Agent messages and results associated with the current workflow, including prompt plans, generation status, previews, and recovery actions.
_Avoid_: global chat history, agent log
