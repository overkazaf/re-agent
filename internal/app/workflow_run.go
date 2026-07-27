package app

import (
	"context"

	"github.com/overkazaf/re-agent/internal/core"
	"github.com/overkazaf/re-agent/internal/types"
	"github.com/overkazaf/re-agent/internal/workflow"
)

type workflowRunOptions struct {
	Ctx     context.Context
	OnEvent func(core.LoopEvent)
	OnPhase func(provider string, role types.AgentRole)
}

func runWithWorkflow(state *State, prompt string, options workflowRunOptions) (types.RunResult, error) {
	if workflow.ShouldDelegate(state.Workflow, state.Config, state.Provider, state.Role) {
		return runDelegatedWorkflow(state, prompt, options)
	}
	wrapped := workflow.WrapPrompt(prompt, state.Workflow, state.Config, state.Provider)
	return state.Loop.Run(wrapped, core.RunOptions{
		Role: state.Role, ProviderName: state.Provider, Ctx: options.Ctx, OnEvent: options.OnEvent,
	})
}

func runDelegatedWorkflow(state *State, prompt string, options workflowRunOptions) (types.RunResult, error) {
	planner := state.Config.PlannerProvider
	executor := state.Config.ExecutorProvider

	if options.OnPhase != nil {
		options.OnPhase(planner, types.RolePlanner)
	}
	plannerResult, err := state.Loop.Run(workflow.DelegatedPlannerPrompt(prompt), core.RunOptions{
		Role:         types.RolePlanner,
		ProviderName: planner,
		Ctx:          options.Ctx,
		OnEvent:      options.OnEvent,
		Tools:        workflow.DelegatedPlannerTools(state.Tools),
	})
	if err != nil || plannerResult.Interrupted {
		return plannerResult, err
	}

	if options.OnPhase != nil {
		options.OnPhase(executor, types.RoleExecutor)
	}
	executorResult, err := state.Loop.Run(workflow.DelegatedExecutorPrompt(prompt, lastAssistantText(plannerResult.Messages)), core.RunOptions{
		Role:         types.RoleExecutor,
		ProviderName: executor,
		Ctx:          options.Ctx,
		OnEvent:      options.OnEvent,
		Isolated:     true,
		SystemPrompt: workflow.DelegatedExecutorSystemPrompt(),
		Tools:        workflow.DelegatedExecutorTools(state.Tools),
		FreshSession: true,
	})
	if err != nil {
		return executorResult, err
	}
	return combineDelegatedResults(plannerResult, executorResult, planner, executor), nil
}

func combineDelegatedResults(plannerResult, executorResult types.RunResult, planner, executor string) types.RunResult {
	combined := executorResult
	combined.Provider = planner + "->" + executor
	combined.Role = types.RoleAuto
	combined.Turns = plannerResult.Turns + executorResult.Turns
	combined.Usage = plannerResult.Usage
	combined.Usage.Add(executorResult.Usage)
	combined.Interrupted = plannerResult.Interrupted || executorResult.Interrupted
	return combined
}
