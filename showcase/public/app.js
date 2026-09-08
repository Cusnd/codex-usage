const $ = (id) => document.getElementById(id);
const format = (value) => {
  const number = Number(value);
  return number >= 1e6 ? `${Number((number / 1e6).toFixed(2))}M` : number >= 1e3 ? `${Number((number / 1e3).toFixed(2))}K` : String(number);
};
const palette = ['#244ccc', '#097987', '#b64970'];
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showProject(project, buttons) {
  buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.project === project.name)));
  $('project-title').textContent = project.name;
  $('project-total').textContent = format(project.totalTokens);
  const segments = [
    ['Uncached input', project.uncachedInputTokens],
    ['Cache reads', project.cachedInputTokens],
    ['Output', project.outputTokens],
  ];
  $('composition').replaceChildren();
  $('composition-labels').replaceChildren();
  $('composition').setAttribute('aria-label', segments.map(([label, value]) => `${label}: ${format(value)} tokens`).join(', '));
  segments.forEach(([label, value], index) => {
    const segment = element('span');
    segment.style.flex = String(Number(value));
    segment.style.background = palette[index];
    $('composition').append(segment);
    const legend = element('div');
    const dot = element('span', 'legend-dot');
    dot.style.background = palette[index];
    legend.append(dot, document.createTextNode(label), element('b', '', format(value)));
    $('composition-labels').append(legend);
  });
  $('task-list').replaceChildren();
  for (const task of project.tasks) {
    const row = element('div', 'task-row');
    const title = element('div', '', task.title);
    title.append(element('small', '', `${task.turnCount} turns · own usage`));
    row.append(title, element('b', '', format(task.totalTokens)));
    $('task-list').append(row);
  }
}
async function initialize() {
  try {
    const response = await fetch('data.json');
    if (!response.ok) throw new Error('Example unavailable');
    const data = await response.json();
    $('all-total').textContent = format(data.summary.totalTokens);
    $('all-tasks').textContent = data.summary.threadCount;
    $('all-turns').textContent = data.summary.turnCount;
    const maximum = Math.max(...data.trend.map((day) => Number(day.totalTokens)));
    $('chart').setAttribute('aria-label', data.trend.map((day) => `${day.date}: ${format(day.totalTokens)} tokens`).join('; '));
    for (const day of data.trend) {
      const cell = element('div', 'bar-cell');
      const bar = element('div', Number(day.totalTokens) === maximum ? 'bar peak' : 'bar');
      bar.style.height = `${Number(day.totalTokens) / maximum * 82}%`;
      bar.append(element('span', 'bar-value', format(day.totalTokens)));
      cell.append(bar, element('span', 'bar-date', day.date.slice(5).replace('-', '.')));
      $('chart').append(cell);
    }
    const buttons = [];
    for (const project of data.projects) {
      const button = element('button', 'project-button');
      button.type = 'button';
      button.dataset.project = project.name;
      const title = element('span', '', project.name);
      title.append(element('small', '', `${project.tasks.length} tasks · ${Number((Number(project.totalTokens) / Number(data.summary.totalTokens) * 100).toFixed(1))}%`));
      button.append(title, element('strong', '', format(project.totalTokens)));
      button.addEventListener('click', () => showProject(project, buttons));
      buttons.push(button);
      $('project-buttons').append(button);
    }
    $('team-self').textContent = format(data.team.self);
    $('team-children').textContent = format(data.team.subagents);
    $('team-total').textContent = format(data.team.total);
    for (const agent of data.team.agents) {
      const row = element('div', 'team-row');
      const name = element('div', '', agent.title);
      name.style.paddingInlineStart = `${agent.depth * 18}px`;
      name.append(element('span', '', agent.depth === 0 ? 'Current agent' : agent.depth === 1 ? 'Subagent' : `Nested subagent · level ${agent.depth}`));
      row.append(name, element('b', '', format(agent.totalTokens)));
      $('team-rows').append(row);
    }
    showProject(data.projects[0], buttons);
    $('demo-loading').hidden = true;
    $('demo-content').hidden = false;
  } catch {
    $('demo-loading').textContent = 'The example could not load. Refresh to try again, or view the application screenshots below.';
  }
}
const captures = {
  analysis: { src: 'analysis.png', width: 1232, height: 1330, alt: 'Real application: seven-day trend, token composition, project list, and selected project tasks', caption: "Follow the seven-day trend into a project's tasks. Select the image to open it at full size." },
  team: { src: 'agent-team.png', width: 1040, height: 553, alt: 'Real application: current agent, two direct subagents, one nested subagent, and team totals', caption: 'Separate the current agent from its descendants, including nested subagents. Select the image to open it at full size.' },
};
document.querySelectorAll('[data-capture]').forEach((button) => {
  button.addEventListener('click', () => {
    const capture = captures[button.dataset.capture];
    document.querySelectorAll('[data-capture]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    Object.assign($('capture-image'), { src: capture.src, alt: capture.alt, width: capture.width, height: capture.height });
    $('capture-link').href = capture.src;
    $('capture-caption').textContent = capture.caption;
  });
});
$('copy-prompt').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('install-prompt').textContent);
    $('copy-status').textContent = 'Copied. Paste it into your agent conversation.';
  } catch {
    $('copy-status').textContent = 'Select and copy the prompt above, then paste it into your agent conversation.';
  }
});
initialize();
