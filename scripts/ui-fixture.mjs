// Shared renderer fixture. No credentials or real GitHub requests.
export async function installClientFixture(page) {
  await page.addInitScript(() => {
    const fixtureParams = new URL(location.href).searchParams;
    const reloadFixture = fixtureParams.has('freshReload');
    const localeFixture = fixtureParams.has('localeFixture');
    const systemLanguage = fixtureParams.get('systemLanguage');
    const systemLanguages = (fixtureParams.get('systemLanguages') || systemLanguage || 'zh-CN').split(',');
    if (systemLanguage) {
      Object.defineProperty(navigator, 'language', { configurable: true, value: systemLanguage });
      Object.defineProperty(navigator, 'languages', { configurable: true, value: [systemLanguage] });
    }
    const problems = [
      { id: 'cf1234a', label: 'Estimated round example', url: 'https://codeforces.com/contest/1234/problem/A', rating: 1000, ratingSource: 'estimated', kind: 'round', hint: 'Try $x^2 + y^2$.' },
      { id: 'cf100001b', label: 'Official Gym example', url: 'https://codeforces.com/gym/100001/problem/B', rating: 1700, ratingSource: 'official', kind: 'gym', hint: 'Consider the graph.' },
      { id: 'cf1731a', label: 'CF1731F', url: 'https://codeforces.com/contest/1731/problem/A', rating: null, ratingSource: 'unknown', kind: 'round', hint: '', sourceWarning: '原仓库题号标注 CF1731F 与题目链接不一致，客户端按链接识别为 CF1731A。提交前请核对原题与题解。' },
      ...[1199, 1200, 1399, 1400, 1599, 1600, 1899, 1900, 2099, 2100, 2399, 2400, 2999, 3000].map((rating, index) => ({ id: `cf${9000 + index}a`, label: `Rating boundary ${rating}`, url: `https://codeforces.com/contest/${9000 + index}/problem/A`, rating, ratingSource: 'unknown', kind: 'round', hint: '' })),
    ];
    if (localeFixture) { problems[0].label = '远端题目标题：原文保持'; problems[0].hint = '远端提示：保持原文 $a+b$。'; }
    const day = { date: '2024-03-05', problems, sourceUrl: 'https://github.com/Yawn-Sean/Daily_CF_Problems', fetchedAt: new Date().toISOString() };
    const secondDay = { ...day, date: '2024-03-06', problems: [{ id: 'cf5678c', label: 'Cross-date batch example', url: 'https://codeforces.com/contest/5678/problem/C', rating: 1600, ratingSource: 'official', kind: 'round', hint: '' }] };
    let auth = { user: { login: 'ui_tester', name: 'UI Tester', avatarUrl: '' }, configured: true, secureStorage: true };
    const defaultClientId = fixtureParams.get('defaultClientId') || '';
    const settingsStorageKey = fixtureParams.get('persistSettings') ? `daily-cf-ui-fixture-settings:${fixtureParams.get('persistSettings')}` : null;
    let settings = { clientId: fixtureParams.get('oauthClientId') || '', language: 'cpp', theme: 'light', ...(fixtureParams.has('paletteId') ? { paletteId: fixtureParams.get('paletteId') } : {}), uiLanguage: fixtureParams.get('uiLanguage') || 'zh-CN' };
    // Opt-in renderer-test storage only: no production settings or credentials are read.
    if (settingsStorageKey && sessionStorage.getItem(settingsStorageKey)) settings = JSON.parse(sessionStorage.getItem(settingsStorageKey));
    const authListeners = new Set();
    const librarySyncListeners = new Set();
    const syncPending = new Map();
    let syncGeneration = 0;
    function emitSync(progress) {
      window.__uiTest.syncEvents.push(structuredClone(progress));
      librarySyncListeners.forEach(callback => callback(progress));
    }
    async function fixtureSync(source) {
      const fixture = window.__uiTest;
      const id = ++syncGeneration;
      const ruleIndex = fixture.syncRules.findIndex(rule => !rule.source || rule.source === source);
      const rule = ruleIndex < 0 ? {} : fixture.syncRules[ruleIndex].persistent ? fixture.syncRules[ruleIndex] : fixture.syncRules.splice(ruleIndex, 1)[0];
      const request = { id, source, tag: rule.tag || '', pending: Boolean(rule.defer), completed: false };
      fixture.syncRequests.push(request);
      if (!rule.silent) emitSync({ phase: 'checking', completed: 0, unit: 'objects' });
      if (!rule.silent) for (const progress of rule.progress || []) emitSync(progress);
      if (rule.defer) await new Promise(resolve => syncPending.set(id, resolve));
      else await Promise.resolve();
      request.pending = false; request.completed = true;
      if (rule.error) {
        // Repository workers serialize progress. A superseded request may reject
        // its caller later, but cannot emit an obsolete worker event.
        if (!rule.silent && id === syncGeneration) emitSync({ phase: 'error', completed: 0, unit: 'objects', message: rule.error });
        throw new Error(rule.error);
      }
      const result = { branch: 'main', revision: String(id).padStart(40, '0') };
      if (!rule.silent && id === syncGeneration) emitSync({ phase: 'ready', completed: 1, total: 1, unit: 'objects', revision: result.revision, updatedAt: new Date().toISOString() });
      return result;
    }
    const fork = name => ({ fullName: name, url: `https://github.com/${name}`, defaultBranch: 'main', ownedUpstream: false });
    const availableForks = [fork('ui_tester/renamed-fork')];
    const batchHistoryProblems = Array.from({ length: 22 }, (_, index) => {
      const problemId = index === 0 ? 'cf5678c' : `cf${7000 + index}a`;
      const date = index === 0 || index % 2 ? '2024-03-06' : '2024-03-05';
      const extension = index === 21 ? 'ml' : index % 2 ? 'py' : 'cpp';
      return { problemId, date, language: index === 21 ? undefined : extension, path: `daily_problems/2024/03/030${date.endsWith('06') ? 6 : 5}/personal_submission/${problemId}_ui_tester.${extension}` };
    });
    const referenceCodes = {
      'cf1234a_alice.cpp': '#include <iostream>\n// Alice: 中文注释\nint main() {\n\tstd::cout << "<img src=x onerror=alert(1)>";\n\treturn 0;\n}\n',
      'cf1234a_bob.cpp': 'int main() { return 42; }\n',
      'cf1234a_charlie.py': 'def solve():\n    print("Hello, community")\n\nsolve()\n',
    };
    const editorialCpp = 'int main() {\n\treturn 0;\n}\n';
    const libraryPending = new Map();
    async function libraryRequest(method, key, refresh, fallback) {
      const fixture = window.__uiTest;
      const ruleIndex = fixture.libraryRules.findIndex(rule => rule.method === method && (rule.key === undefined || rule.key === key) && (rule.refresh === undefined || rule.refresh === refresh));
      const rule = ruleIndex < 0 ? {} : fixture.libraryRules[ruleIndex].persistent ? fixture.libraryRules[ruleIndex] : fixture.libraryRules.splice(ruleIndex, 1)[0];
      const response = structuredClone(Object.hasOwn(rule, 'response') ? rule.response : fallback);
      const request = { id: fixture.libraryRequests.length + 1, method, key, refresh, tag: rule.tag || '', pending: Boolean(rule.defer), completed: false };
      fixture.libraryRequests.push(request);
      if (rule.defer) await new Promise(resolve => libraryPending.set(request.id, resolve));
      request.pending = false; request.completed = true;
      if (rule.error) throw Object.assign(new Error(rule.error), ...(rule.errorCode ? [{ code: rule.errorCode }] : []), ...(rule.rateLimit ? [{ rateLimit: structuredClone(rule.rateLimit) }] : []));
      return response;
    }
    // A fixture revision identifies immutable repository content, just like a
    // Git commit. Rechecking unchanged data must not invent another revision.
    const archiveRevisions = new Map();
    const archiveViews = new Map();
    function fixtureMonth(month, overrides, baseDay = day, nextDay = secondDay) {
      return overrides[month] ?? (month === '2024-03' ? [baseDay, nextDay] : [{ ...baseDay, date: `${month}-05`, ...(month === '1999-12' ? { problems: [{ ...baseDay.problems[0], id: 'cf1999a', label: 'Archive discovery example', url: 'https://codeforces.com/contest/1999/problem/A' }] } : {}) }]);
    }
    function captureArchiveView(months) {
      const fixture = window.__uiTest;
      const overrides = structuredClone(fixture.monthOverrides);
      // Explicit response rules describe remote content changes as well. Delay
      // and error rules alone do not change the content revision.
      const candidateMonths = new Set([...months.map(entry => entry.month), ...Object.keys(overrides), ...fixture.libraryRules.filter(rule => rule.method === 'month' && rule.key).map(rule => rule.key)]);
      for (const month of candidateMonths) {
        const rule = fixture.libraryRules.find(candidate => candidate.method === 'month' && (candidate.key === undefined || candidate.key === month) && (candidate.refresh === undefined || candidate.refresh === true));
        if (rule && Object.hasOwn(rule, 'response')) overrides[month] = structuredClone(rule.response);
      }
      const value = structuredClone({ months, overrides, baseDay: day, nextDay: secondDay, referenceCodes, resourceRevision: fixture.resourceRevision });
      const signature = JSON.stringify(value);
      let revision = archiveRevisions.get(signature);
      if (!revision) { revision = String(archiveRevisions.size + 1).padStart(40, '0'); archiveRevisions.set(signature, revision); }
      archiveViews.set(revision, value);
      return { branch: 'main', revision, months: value.months };
    }
    window.__uiTest = {
      syncRules: fixtureParams.has('holdStartupSync') ? [{ source: 'getDay', defer: true, persistent: true, tag: 'startup-sync', progress: [{ phase: 'downloading', completed: 262144, total: 1048576, unit: 'bytes' }] }] : [], syncRequests: [], syncEvents: [],
      emitSync,
      releaseSync(tag) { const request = this.syncRequests.find(item => item.tag === tag && item.pending); if (!request) throw new Error(`No pending sync tagged ${tag}`); const release = syncPending.get(request.id); syncPending.delete(request.id); request.pending = false; release(); },
      previewDelay: 0, previewFailure: false, previewRequests: [], forkSyncState: 'synced', submitFailure: false, submitDelay: 0, submitCalls: 0, submitRequests: [], savedSettings: null, saveSettingsFailure: false, saveSettingsRequests: [], windowTransitions: [], dayRequests: [], referenceCodes, referenceFailure: false, referenceRequests: [], editorialCpp, copied: null, copyRequests: [], copyFailure: false, copyDelay: 0, browserClipboardCalls: 0, deviceCode: 'ABCD-EFGH', beginLoginCalls: 0, openedUrls: [],
      nextFile: { name: 'alice.cpp', code: referenceCodes['cf1234a_alice.cpp'], language: 'cpp' },
      inspectRequests: [], inspectFailure: false, inspectDelay: 0, newUnchangedProblemId: '', allUnchanged: false, beginLoginDelay: 0, beginLoginCompletions: [], cancelLoginCalls: 0,
      createForkRequests: [], createForkCompletions: [], createForkDelay: 0, createForkFailure: false,
      archiveMonths: [{ month: '2024-03', days: 2 }, { month: '2024-02', days: 1 }], archiveMonthRequests: [], archiveSnapshotRequests: [], snapshotMonthRequests: [],
      referenceRefreshRequests: [], resourceRequests: [], resourceFailure: false, resourceRevision: '',
      externalOpenFailure: false, externalOpenDelay: 0,
      localPaths: { configFile: 'C:\\Users\\ui_tester\\AppData\\Roaming\\daily-cf-client\\settings.json', dataDirectory: 'C:\\Users\\ui_tester\\AppData\\Roaming\\daily-cf-client' },
      localPathsRequests: 0, localPathsFailure: fixtureParams.has('localPathsFailure'), localPathOpenRequests: [], localPathOpenFailure: false, localPathOpenDelay: 0,
      latestDay: reloadFixture ? { ...day, date: '2027-01-01', problems: [{ ...problems[0], label: 'Remote data after browser reload' }] } : structuredClone(day), monthOverrides: {}, dayOverrides: {},
      libraryRules: fixtureParams.has('lateLocalStartup') ? [{ method: 'local', key: 'day:latest', defer: true, tag: 'late-local-startup', response: { kind: 'day', revision: 'a'.repeat(40), day: { ...day, problems: [{ ...problems[0], label: 'Obsolete delayed local preview' }] } } }] : [], libraryRequests: [],
      localViews: fixtureParams.has('localStartup') ? { 'day:latest': { kind: 'day', revision: 'a'.repeat(40), day: { ...day, problems: [{ ...problems[0], label: 'Local snapshot shown while checking' }] } } } : {}, localViewRequests: [], holdInitialLatest: !reloadFixture && !localeFixture,
      makeLibraryDay(date, label, id = 'cf8000a') { return { ...day, date, problems: [{ ...problems[1], id, label, url: `https://codeforces.com/gym/8000/problem/A` }] }; },
      releaseLibrary(tag) { const request = this.libraryRequests.find(item => item.tag === tag && item.pending); if (!request) throw new Error(`No pending library request tagged ${tag}`); const release = libraryPending.get(request.id); libraryPending.delete(request.id); release(); },
      legacyCalls: 0, importDelay: 0, importCalls: 0, importCompletions: 0, openPullRequestRequests: [], openPullRequestFailure: false, openPullRequestAvailable: true, openPullRequestDelay: 0, contributionDelay: 0, contributionBackgroundDelay: 0, contributionFailure: false, contributionFilesTruncated: false, contributionIncomplete: false, contributionRows: null, contributionRequests: [], contributionCompletions: [],
      switchAccount(login) { auth = { ...auth, user: login ? { login, name: login, avatarUrl: '' } : null }; authListeners.forEach(callback => callback(auth)); },
      setConfigured(configured) { auth = { ...auth, configured }; authListeners.forEach(callback => callback(auth)); },
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { window.__uiTest.browserClipboardCalls += 1; throw new Error('Renderer must use the native ClientAPI clipboard.'); } } });
    function assertNewTarget(input) { if (input.target?.kind !== 'new') throw new Error('Only new PR creation is supported'); }
    window.dailyCF = {
      isDesktop: !fixtureParams.has('nonDesktop'),
      getAppUpdateState: async () => ({ phase: 'idle', currentVersion: 'fixture', target: { platform: 'windows', arch: 'x86_64', packageKind: 'nsis', mode: 'installer', development: false } }),
      checkAppUpdate: async () => ({ phase: 'current', currentVersion: 'fixture', target: { platform: 'windows', arch: 'x86_64', packageKind: 'nsis', mode: 'installer', development: false } }),
      downloadAppUpdate: async () => { throw new Error('No update selected in this fixture'); },
      cancelAppUpdate: async () => {},
      openAppUpdate: async () => { throw new Error('No downloaded update in this fixture'); },
      revealAppUpdate: async () => { throw new Error('No downloaded update in this fixture'); },
      onAppUpdate: () => () => {},
      getLocalPaths: async () => { const fixture = window.__uiTest; fixture.localPathsRequests += 1; if (fixture.localPathsFailure) throw new Error('Fixture file locations unavailable'); return structuredClone(fixture.localPaths); },
      openLocalPath: async target => { const fixture = window.__uiTest; fixture.localPathOpenRequests.push(target); await new Promise(resolve => setTimeout(resolve, fixture.localPathOpenDelay)); if (fixture.localPathOpenFailure) throw new Error('Fixture file manager failed'); },
      resolveWindowTransition: async approved => { window.__uiTest.windowTransitions.push(approved); },
      bootstrap: async () => ({ auth, settings, defaultClientId, version: 'fixture', repository: 'Yawn-Sean/Daily_CF_Problems', systemLanguages }),
      onLibrarySync: callback => { librarySyncListeners.add(callback); return () => librarySyncListeners.delete(callback); },
      syncLibrary: async () => fixtureSync('syncLibrary'),
      getLocalLibraryView: async request => {
        const key = request.kind === 'day' ? `day:${request.date || 'latest'}` : request.kind === 'archive' ? `archive:${request.scope}:${request.month || ''}` : request.kind === 'resources' ? `resources:${request.date}:${request.problemId}` : `reference:${request.path}`;
        const fixture = window.__uiTest;
        fixture.localViewRequests.push(structuredClone(request));
        return libraryRequest('local', key, false, fixture.localViews[key] ?? null);
      },
      getDay: async (date, refresh = false) => {
        await fixtureSync('getDay');
        const fixture = window.__uiTest;
        fixture.dayRequests.push(date || null);
        if (!date && fixture.holdInitialLatest) { fixture.holdInitialLatest = false; fixture.libraryRules.push({ method: 'day', key: 'latest', tag: `initial-latest-${fixture.libraryRequests.length + 1}`, defer: true, response: { ...day, date: '2024-03-04', problems: [{ ...problems[0], label: 'Stale initial library result' }] } }); }
        if (!date && refresh) fixture.holdInitialLatest = false;
        return libraryRequest('day', date || 'latest', refresh, fixture.dayOverrides[date] || (date === secondDay.date ? secondDay : date ? { ...day, date } : fixture.latestDay));
      },
      getArchiveMonths: async (refresh = false) => { await fixtureSync('getArchiveMonths'); window.__uiTest.archiveMonthRequests.push({ refresh }); return libraryRequest('months', 'directory', refresh, window.__uiTest.archiveMonths); },
      getArchiveSnapshot: async () => {
        await fixtureSync('getArchiveSnapshot');
        const fixture = window.__uiTest;
        // Keep shared rule names so remote-read regressions exercise both paths.
        const directoryRequest = { refresh: true };
        fixture.archiveMonthRequests.push(directoryRequest);
        const months = await libraryRequest('months', 'directory', true, fixture.archiveMonths);
        const snapshot = captureArchiveView(months);
        directoryRequest.snapshot = snapshot.revision;
        fixture.archiveSnapshotRequests.push({ revision: snapshot.revision });
        return snapshot;
      },
      getMonthFromSnapshot: async (month, snapshot) => {
        const fixture = window.__uiTest;
        fixture.snapshotMonthRequests.push({ month, snapshot: structuredClone(snapshot) });
        const view = snapshot && archiveViews.get(snapshot.revision);
        if (!view) throw new Error('Missing fixture snapshot');
        const expected = fixtureMonth(month, view.overrides, view.baseDay, view.nextDay);
        const response = await libraryRequest('month', month, true, expected);
        if (JSON.stringify(response) !== JSON.stringify(expected)) throw new Error('Fixture month content changed without a corresponding snapshot revision.');
        return response;
      },
      getMonth: async (month, refresh = false) => { await fixtureSync('getMonth'); return libraryRequest('month', month, refresh, window.__uiTest.monthOverrides[month] || (month === '2024-03' ? [day, secondDay] : [{ ...day, date: `${month}-05`, ...(month === '1999-12' ? { problems: [{ ...problems[0], id: 'cf1999a', label: 'Archive discovery example', url: 'https://codeforces.com/contest/1999/problem/A' }] } : {}) }])); },
      getResources: async (date, problemId, refresh) => { await fixtureSync('getResources'); window.__uiTest.resourceRequests.push({ date, problemId, refresh }); if (window.__uiTest.resourceFailure) throw new Error('Fixture resources failure'); return libraryRequest('resources', `${date}:${problemId}`, refresh, { editorial: `## Solution\n\n${window.__uiTest.resourceRevision}\n\nUse $x^2$ and $$y = x + 1$$.\n\n\`\`\`cpp\n${editorialCpp}\`\`\`\n\n\`\`\`python\ndef solve():\n    print("<script>alert(1)</script>")\n\`\`\``, editorialUrl: null, references: Object.keys(referenceCodes).map(name => ({ name, path: name, language: name.endsWith('.py') ? 'Python' : 'C++', url: `https://github.com/example/example/blob/main/${name}` })) }); },
      getReference: async (path, refresh = false) => { await fixtureSync('getReference'); window.__uiTest.referenceRequests.push(path); window.__uiTest.referenceRefreshRequests.push({ path, refresh }); if (window.__uiTest.referenceFailure) throw new Error('Fixture reference fetch failure'); return libraryRequest('reference', path, refresh, referenceCodes[path] || ''); },
      saveSettings: async value => {
        window.__uiTest.saveSettingsRequests.push(structuredClone(value));
        if (window.__uiTest.saveSettingsFailure) throw new Error('Fixture settings save failure');
        settings = fixtureParams.has('validateSettings') ? (await import('/electron/guards.ts')).settingsInput(value) : value;
        if (settingsStorageKey) sessionStorage.setItem(settingsStorageKey, JSON.stringify(settings));
        window.__uiTest.savedSettings = settings;
        return settings;
      },
      getForks: async () => structuredClone(availableForks),
      validateFork: async name => fork(name),
      createFork: async name => {
        const id = window.__uiTest.createForkRequests.length + 1;
        const failed = window.__uiTest.createForkFailure;
        const login = auth.user?.login;
        window.__uiTest.createForkRequests.push({ id, name });
        await new Promise(resolve => setTimeout(resolve, window.__uiTest.createForkDelay));
        window.__uiTest.createForkCompletions.push(id);
        if (failed) throw new Error('Fixture GitHub rejected creating another Fork in this repository network.');
        const created = fork(`${login}/${name}`);
        if (!availableForks.some(item => item.fullName === created.fullName)) availableForks.push(created);
        return created;
      },
      getOpenPullRequests: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Removed existing-PR API called'); },
      inspectSubmissionFile: async input => {
        const fixture = window.__uiTest; fixture.inspectRequests.push(structuredClone(input));
        await new Promise(resolve => setTimeout(resolve, fixture.inspectDelay));
        if (fixture.inspectFailure) throw new Error('Fixture repository file check failure');
        const { submissionPath } = await import('/shared/domain.ts');
        return { path: submissionPath(input), exists: input.problemId === 'cf100001b' };
      },
      beginLogin: async () => { const id = ++window.__uiTest.beginLoginCalls; const userCode = window.__uiTest.deviceCode; await new Promise(resolve => setTimeout(resolve, window.__uiTest.beginLoginDelay)); window.__uiTest.beginLoginCompletions.push(id); return { userCode, verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 100000 }; },
      cancelLogin: async () => { window.__uiTest.cancelLoginCalls += 1; },
      loginWithToken: async () => auth,
      logout: async () => ({ ...auth, user: null }),
      saveDraft: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Removed API called'); },
      deleteDraft: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Removed API called'); },
      previewSubmission: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Single-item API called by batch composer'); },
      submit: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Single-item API called by batch composer'); },
      previewBatchSubmission: async input => {
        window.__uiTest.previewRequests.push(structuredClone(input));
        await new Promise(resolve => setTimeout(resolve, window.__uiTest.previewDelay));
        if (window.__uiTest.previewFailure) throw new Error('Fixture batch preview failure');
        const { submissionPath, submissionExtension } = await import('/shared/domain.ts');
        const items = input.items.map(item => {
          const unchanged = window.__uiTest.allUnchanged || item.problemId === window.__uiTest.newUnchangedProblemId;
          const existing = item.problemId === 'cf100001b' || unchanged;
          const previousCode = unchanged ? item.code : 'print("previous solution")\n';
          return { date: item.date, problemId: item.problemId, language: item.language, extension: submissionExtension(item), author: item.author, path: submissionPath(item), bytes: new TextEncoder().encode(item.code).length, existing, unchanged, ...(existing ? { previous: { sha: '2'.repeat(40), code: previousCode, bytes: new TextEncoder().encode(previousCode).length, truncated: false } } : {}), problem: [...problems, ...secondDay.problems, ...Object.values(window.__uiTest.monthOverrides).flatMap(days => days.flatMap(entry => entry.problems))].find(problem => problem.id === item.problemId) };
        });
        assertNewTarget(input);
        const syncState = window.__uiTest.forkSyncState;
        const forkSync = { state: syncState, repository: settings.forkRepository, branch: 'main', upstreamSha: 'a'.repeat(40), forkSha: 'b'.repeat(40), aheadBy: ['ahead', 'diverged'].includes(syncState) ? 2 : 0, behindBy: ['behind', 'diverged'].includes(syncState) ? 3 : 0 };
        return { items, title: `Fixture PR · ${items.length} files`, body: 'Review me', forkRepository: settings.forkRepository, branch: 'fixture', bytes: items.reduce((sum, item) => sum + item.bytes, 0), forkSync };
      },
      submitBatch: async input => {
        window.__uiTest.submitCalls += 1;
        window.__uiTest.submitRequests.push(structuredClone(input));
        await new Promise(resolve => setTimeout(resolve, window.__uiTest.submitDelay));
        if (window.__uiTest.submitFailure) throw new Error('Fixture batch submission failure');
        const stamp = '2026-10-07T08:00:00.000Z';
        const { submissionPath } = await import('/shared/domain.ts');
        const contributionProblems = input.items.map(item => ({ date: item.date, problemId: item.problemId, language: item.language, path: submissionPath(item) }));
        assertNewTarget(input);
        return { record: { id: 'fixture-batch-10', number: 10, title: `Fixture PR · ${input.items.length} files`, url: 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/10', state: 'open', createdAt: stamp, updatedAt: stamp, problems: contributionProblems, filesTruncated: false }, reused: false };
      },
      getContributions: async (page = 1) => {
        const login = auth.user?.login || '';
        const failed = window.__uiTest.contributionFailure;
        const filesTruncated = window.__uiTest.contributionFilesTruncated;
        const incomplete = window.__uiTest.contributionIncomplete;
        const overrideRows = structuredClone(window.__uiTest.contributionRows);
        const id = window.__uiTest.contributionRequests.length + 1;
        window.__uiTest.contributionRequests.push({ id, login, page });
        const delay = page > 1 ? window.__uiTest.contributionBackgroundDelay : window.__uiTest.contributionDelay;
        await new Promise(resolve => setTimeout(resolve, delay));
        window.__uiTest.contributionCompletions.push({ id, login, page });
        if (failed) throw new Error('Fixture GitHub connection failure');
        const stamp = '2026-10-07T08:00:00.000Z';
        const rows = login === 'ui_tester' ? overrideRows ?? [
          { id: 'manual-7', number: 7, title: '补交周末练习：我的实现', url: 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/7', state: 'merged', createdAt: stamp, updatedAt: stamp, problems: [], filesTruncated: false },
          { id: 'parsed-8', number: 8, title: '20240305 cf1234a (C++) - ui_tester', url: 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/8', state: 'open', createdAt: stamp, updatedAt: stamp, problemId: 'cf1234a', date: '2024-03-05', language: 'cpp', problems: [{ problemId: 'cf1234a', date: '2024-03-05', language: 'cpp', path: 'daily_problems/2024/03/0305/personal_submission/cf1234a_ui_tester.cpp' }], filesTruncated: false },
          { id: 'manual-9', number: 9, title: '整理参考代码说明', url: 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/9', state: 'closed', createdAt: stamp, updatedAt: stamp, problems: [], filesTruncated: false },
          { id: 'batch-11', number: 11, title: '暑假练习合集：22 份解答', url: 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/11', state: 'merged', createdAt: stamp, updatedAt: stamp, problems: batchHistoryProblems, filesTruncated, otherFiles: [{ path: 'README.md', status: 'modified' }, { path: 'daily_problems/2024/03/0305/personal_submission/cf6999a_ui_tester.cpp', status: 'removed' }] },
        ] : [];
        const uniqueRows = [...new Map(rows.map(row => [row.id, row])).values()];
        return libraryRequest('contributions', `${login}:${page}`, false, { items: rows.slice((page - 1) * 2, page * 2), totalCount: uniqueRows.length, openCount: uniqueRows.filter(row => row.state === 'open').length, mergedCount: uniqueRows.filter(row => row.state === 'merged').length, closedCount: uniqueRows.filter(row => row.state === 'closed').length, page, pageSize: 2, hasMore: page * 2 < rows.length, truncated: false, incomplete, login, repository: 'Yawn-Sean/Daily_CF_Problems', fetchedAt: stamp });
      },
      importCode: async () => {
        const file = structuredClone(window.__uiTest.nextFile);
        window.__uiTest.importCalls += 1;
        await new Promise(resolve => setTimeout(resolve, window.__uiTest.importDelay));
        window.__uiTest.importCompletions += 1;
        if (!file || file.extension !== undefined) return file;
        const { importExtension } = await import('/shared/file-formats.ts');
        return { ...file, extension: importExtension(file.name) };
      },
      exportCode: async () => { window.__uiTest.legacyCalls += 1; throw new Error('Removed API called'); },
      copyText: async value => {
        const failed = window.__uiTest.copyFailure;
        window.__uiTest.copyRequests.push(value);
        await new Promise(resolve => setTimeout(resolve, window.__uiTest.copyDelay));
        if (failed) throw new Error('Fixture native clipboard failure');
        window.__uiTest.copied = value;
      },
      openExternal: async url => { const fixture = window.__uiTest; fixture.openedUrls.push(url); if (fixture.externalOpenDelay) await new Promise(resolve => setTimeout(resolve, fixture.externalOpenDelay)); if (fixture.externalOpenFailure) throw new Error('Fixture browser launch failure'); },
      onAuthChanged: callback => { authListeners.add(callback); return () => authListeners.delete(callback); },
      onSubmissionProgress: () => () => {},
    };
  });
}
