import { PlatformAvatar } from '@/components/brand-icons';
import { brandFor } from '../brands';

export interface TargetSelectorProps {
  targets: string[];
  target: string | null;
  saveLocally: boolean;
  onTarget: (t: string | null) => void;
  onSaveLocally: (v: boolean) => void;
}

export function TargetSelector({ targets, target, saveLocally, onTarget, onSaveLocally }: TargetSelectorProps) {
  return (
    <div className="cp-panel">
      <div className="cp-panel-top">
        <div className="cp-section-title">Send context</div>
        <p className="cp-hint">Continue this conversation in (optional):</p>
      </div>
      <div className="cp-scroll">
        <div className="cp-targets" role="radiogroup" aria-label="Target AI">
          {targets.map((t) => {
            const b = brandFor(t);
            const checked = target === t;
            return (
              <label key={t} className={`cp-target${checked ? ' cp-target--selected' : ''}`}>
                <input
                  type="radio"
                  name="cira-target"
                  value={t}
                  checked={checked}
                  onChange={() => onTarget(t)}
                  onClick={() => {
                    if (checked) onTarget(null); // click again to unselect
                  }}
                />
                <PlatformAvatar source={t} initial={b.initial} color={b.color} size={20} radius={6} />
                <span>{b.name}</span>
              </label>
            );
          })}
        </div>
        <label className="cp-save-toggle">
          <input type="checkbox" checked={saveLocally} onChange={(e) => onSaveLocally(e.target.checked)} />
          <span>
            <strong>Save locally</strong>
            <span className="cp-hint">Store the PCO in the browser and ~/.cira/contexts (native host).</span>
          </span>
        </label>
      </div>
    </div>
  );
}
