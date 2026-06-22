/**
 * DeployControls — Module D · Task D1 (Command Integration, view).
 *
 * The DEPLOY SWARM control group that mounts into the DashboardShell
 * `deployControls` header slot. Pure presentation: every behaviour comes from
 * the `useDeploySwarm` orchestrator (the actual D1 glue). This component just
 * renders the legacy `.deploy-controls` markup (DRAW AREA · CLEAR · DEPLOY
 * SWARM + status hint) and forwards clicks to the controller.
 *
 * Reproduced verbatim from `six_eyes_dashboard.html` (header `.deploy-controls`
 * block, lines ~457-463) so the migrated header matches the vanilla dashboard
 * pixel-for-pixel — no layout shift (Output Constraint).
 */

import type { DeploySwarmController } from '../controllers/useDeploySwarm';
import './DeployControls.css';

export interface DeployControlsProps {
  /** The D1 orchestrator from `useDeploySwarm`. */
  controller: DeploySwarmController;
}

export default function DeployControls({ controller }: DeployControlsProps) {
  const { hint, hintState, canDeploy, canClear, startDrawing, clear, deploy } =
    controller;

  return (
    <div className="deploy-controls">
      <span className={`deploy-hint${hintState !== 'idle' ? ` ${hintState}` : ''}`}>
        {hint}
      </span>
      <button type="button" className="deploy-btn ghost" onClick={startDrawing}>
        DRAW AREA
      </button>
      <button
        type="button"
        className="deploy-btn ghost"
        onClick={clear}
        disabled={!canClear}
      >
        CLEAR
      </button>
      <button
        type="button"
        className="deploy-btn"
        onClick={deploy}
        disabled={!canDeploy}
      >
        DEPLOY SWARM
      </button>
    </div>
  );
}
