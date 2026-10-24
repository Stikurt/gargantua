"""Finite executable protocol model; does not exercise production server code."""
from __future__ import annotations
import argparse, collections, hashlib, itertools, json, pathlib, random, time


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Violation(AssertionError):
    def __init__(self, code, trace):
        self.code, self.trace = code, list(trace)
        super().__init__(code)


class LibraryModel:
    def __init__(self, mutant=None):
        self.mutant = mutant
        self.trace, self.checks = [], 0
        self.requests, self.command_log = {}, []
        self.commands, self.jobs = {}, {}
        self.files, self.publications, self.translation_cache, self.audio_cache = {}, {}, {}, {}
        self.translation_operations, self.audio_operations = {}, {}
        self.accepted_text_proofs, self.accepted_audio_proofs = {}, {}
        self.translation_calls, self.audio_calls, self.read_checks = [], [], []
        self.grants = {'A': True, 'B': True}
        self.capabilities = {'A': {'translate', 'tts'}, 'B': {'translate', 'tts'}}
        self.providers = {'translate': True, 'tts': True}
        self.resources, self.server = True, True
        self.local_files, self.local_index = {}, {}
        self.local_staging = None
        self.source_revision = 1
        self.input_bytes = b'original-source-1'
        self.reset_attempt()

    def reset_attempt(self):
        self.input_scan = self.output_scan = None
        self.output_bytes = None
        self.identity_ok = False

    @property
    def operation(self):
        return 'book@' + str(self.source_revision)

    def event(self, action, **details):
        self.trace.append({'action': action, **details})
        self.check()

    def fail_unless(self, condition, code):
        self.checks += 1
        if not condition:
            raise Violation(code, self.trace)

    def check(self):
        grouped = collections.defaultdict(set)
        for actor, key, body, rid in self.command_log:
            grouped[(actor, key, body)].add(rid)
            self.fail_unless(self.requests[rid]['actor'] == actor, 'INITIATOR_PRESERVED')
        self.fail_unless(all(len(v) == 1 for v in grouped.values()), 'COMMAND_IDEMPOTENCY')
        for pid, pub in self.publications.items():
            self.fail_unless(self.files.get(pub['hash']) is not None and digest(self.files[pub['hash']]) == pub['hash'], 'PUBLISHED_BYTES_EXIST')
            proof = pub['proof']
            self.fail_unless(proof['inputActual'] == proof['inputReport'] and proof['outputActual'] == proof['outputReport'] and proof['identity'], 'SECURITY_GATE_BOUND_TO_BYTES')
            self.fail_unless(proof['providedFence'] == proof['currentFence'], 'STALE_WORKER_REJECTED')
            self.fail_unless(proof['eligibleAtCommit'], 'AUTHORITY_AT_COMMIT')
            self.fail_unless(self.jobs[pid]['status'] == 'succeeded', 'POST_COMMIT_FAILURE_IS_NOT_IMPORT_FAILURE')
        for expected, returned in self.translation_calls:
            self.fail_unless(self.translation_cache[returned]['parameters'] == expected, 'TRANSLATION_VARIANTS_SEPARATE')
        for expected, returned in self.audio_calls:
            self.fail_unless(self.audio_cache[returned]['parameters'] == expected, 'AUDIO_PINNED_TO_TEXT_AND_VOICE')
        for result, proof in self.accepted_text_proofs.items():
            self.fail_unless(digest(self.translation_cache[result]) == proof, 'ACCEPTED_TRANSLATION_IMMUTABLE')
        for result, proof in self.accepted_audio_proofs.items():
            self.fail_unless(digest(self.audio_cache[result]) == proof, 'ACCEPTED_AUDIO_IMMUTABLE')
        for req in self.requests.values():
            self.fail_unless(req['actor'] in ('A', 'B'), 'INITIATOR_PRESERVED')
            if req['status'] == 'satisfied':
                text = self.translation_cache.get(req.get('translation'))
                audio = self.audio_cache.get(req.get('audio'))
                self.fail_unless(text is not None and text['accepted'] and text['complete'] and text['parameters'][0] == req['book'], 'TEXT_READY_IS_NOT_PARTIAL_TRANSLATION')
                self.fail_unless(not req['needsAudio'] or (audio is not None and audio['complete'] and audio['accepted'] and audio['parameters'][0] == req['translation']), 'BOOK_READY_IS_NOT_AUDIO_READY')
        for pid, sha in self.local_index.items():
            self.fail_unless(sha in self.local_files and digest(self.local_files[sha]) == sha, 'LOCAL_INDEX_HAS_VERIFIED_BYTES')
        for expected, observed in self.read_checks:
            self.fail_unless(expected == observed, 'OFFLINE_READING_INDEPENDENT_OF_SESSION')

    def submit(self, actor, key, body):
        command = (actor, key)
        body_hash = digest(body)
        if command in self.commands and self.mutant != 'duplicate-command':
            old_hash, rid = self.commands[command]
            if old_hash != body_hash:
                self.event('command-conflict', actor=actor)
                return None
        else:
            rid = 'request-' + str(len(self.requests) + 1)
            self.commands[command] = (body_hash, rid)
            self.requests[rid] = {'actor': actor, 'status': 'pending', 'book': None, 'needsAudio': body.get('audio', True), 'sourceRevision': self.source_revision}
            job = self.jobs.setdefault(self.operation, {'consumers': set(), 'fence': 0, 'status': 'queued'})
            if self.mutant == 'reuse-loses-initiator' and job['consumers']:
                self.requests[next(iter(job['consumers']))]['actor'] = actor
            job['consumers'].add(rid)
            if self.operation in self.publications and self.grants[actor]:
                self.requests[rid].update(book=self.operation, status='text-original-ready')
        self.command_log.append((actor, key, body_hash, rid))
        self.event('submit', actor=actor, request=rid)
        return rid

    def cancel(self, rid):
        req = self.requests[rid]
        req['status'] = 'cancelled'
        job = self.jobs['book@' + str(req['sourceRevision'])]
        job['consumers'].discard(rid)
        if self.mutant == 'cancel-shared-job' or (not job['consumers'] and job['status'] != 'succeeded'):
            job['status'] = 'cancelled'
        self.event('cancel', request=rid)
        self.fail_unless(not job['consumers'] or job['status'] != 'cancelled', 'ONE_CANCEL_DOES_NOT_CANCEL_OTHER_REQUESTS')

    def eligible(self):
        return [rid for rid in self.jobs[self.operation]['consumers'] if self.grants[self.requests[rid]['actor']]]

    def claim(self):
        job = self.jobs[self.operation]
        if self.operation in self.publications:
            self.event('claim-reused-publication')
            return None
        if (not self.resources and self.mutant != 'ignore-resources') or not self.eligible():
            self.event('claim-waiting')
            return None
        self.fail_unless(self.resources, 'HEAVY_ADMISSION_RESPECTS_RESOURCES')
        job['fence'] += 1
        job['status'] = 'running'
        self.reset_attempt()
        self.event('claim', fence=job['fence'])
        return job['fence']

    def prepare(self, scanner=True, identity=True):
        self.input_scan = digest(self.input_bytes) if scanner else None
        self.output_bytes = b'inert:' + self.input_bytes
        self.output_scan = digest(self.output_bytes) if scanner else None
        self.identity_ok = identity
        self.event('scan-parse-scan-verify', scanner=scanner, identity=identity)

    def expire(self):
        self.jobs[self.operation]['fence'] += 1
        self.event('lease-expired', fence=self.jobs[self.operation]['fence'])

    def publish(self, fence, crash=None):
        pid = self.operation
        job = self.jobs[pid]
        if pid in self.publications:
            for rid in self.eligible():
                if self.requests[rid]['book'] is None and self.requests[rid]['status'] != 'cancelled':
                    self.requests[rid].update(book=pid, status='text-original-ready')
            self.event('publish-reused', publication=pid)
            return pid
        if fence != job['fence'] and self.mutant != 'accept-stale-worker':
            self.event('publish-rejected-stale')
            return None
        eligible = self.eligible()
        if not eligible and self.mutant != 'cached-grant':
            self.event('publish-rejected-policy')
            return None
        good_gate = self.input_scan == digest(self.input_bytes) and self.output_bytes is not None and self.output_scan == digest(self.output_bytes) and self.identity_ok
        if not good_gate and self.mutant != 'skip-security-gate':
            self.event('publish-rejected-security')
            return None
        sha = digest(self.output_bytes)
        self.files[sha] = self.output_bytes
        if crash == 'before-commit':
            self.event('crash-before-commit', orphanHash=sha)
            return None
        self.publications[pid] = {'hash': sha, 'proof': {'inputActual': digest(self.input_bytes), 'inputReport': self.input_scan, 'outputActual': sha, 'outputReport': self.output_scan, 'identity': self.identity_ok, 'providedFence': fence, 'currentFence': job['fence'], 'eligibleAtCommit': bool(eligible)}}
        job['status'] = 'succeeded'
        for rid in eligible:
            self.requests[rid]['book'] = pid
            self.requests[rid]['status'] = 'text-original-ready'
        self.event('publication-committed', publication=pid)
        if crash in ('after-commit', 'cleanup-failed'):
            if self.mutant == 'cleanup-fails-import':
                job['status'] = 'failed'
            self.event('cleanup-pending', cause=crash)
        return pid

    def stage_allowed(self, pid, capability):
        return any(r['book'] == pid and r['status'] != 'cancelled' and capability in self.capabilities[r['actor']] for r in self.requests.values())

    def translate(self, pid, glossary='G1', variant='default', complete=True, accepted=True):
        if not self.providers['translate']:
            self.event('translation-awaiting-provider')
            return None
        if not self.resources or pid not in self.publications:
            self.event('translation-waiting')
            return None
        permitted = self.stage_allowed(pid, 'translate')
        if not permitted and self.mutant != 'implicit-translation-grant':
            self.event('translation-waiting-permission')
            return None
        self.fail_unless(permitted, 'TRANSLATION_GRANT_IS_INDEPENDENT')
        params = (pid, self.publications[pid]['hash'], 'ru', 'model-v1', glossary, variant)
        key = digest(params if self.mutant != 'ignore-glossary' else params[:4])
        result = self.translation_operations.get(key)
        previous = self.translation_cache.get(result)
        if previous is None or (not (previous['complete'] and previous['accepted']) and complete and accepted):
            # Operation/cache pointers may advance; every actual result remains immutable.
            result = digest((key, 'translation-result', len(self.translation_cache) + 1))
            self.translation_cache[result] = {'parameters': params, 'complete': complete, 'accepted': accepted}
            self.translation_operations[key] = result
            if complete and accepted:
                self.accepted_text_proofs[result] = digest(self.translation_cache[result])
        self.translation_calls.append((params, result))
        self.event('translation-result', result=result, complete=self.translation_cache[result]['complete'], accepted=self.translation_cache[result]['accepted'])
        return result

    def narrate(self, tid, voice='voice-ru-v1', complete=True, accepted=True):
        if not self.providers['tts']:
            self.event('audio-awaiting-provider')
            return None
        text = self.translation_cache.get(tid)
        if not self.resources or text is None or not text['accepted'] or not text['complete']:
            self.event('audio-waiting')
            return None
        permitted = self.stage_allowed(text['parameters'][0], 'tts')
        if not permitted and self.mutant != 'implicit-tts-grant':
            self.event('audio-waiting-permission')
            return None
        self.fail_unless(permitted, 'TTS_GRANT_IS_INDEPENDENT')
        params = (tid, voice, 'tts-model-v1', 'rate=1')
        key = digest(params if self.mutant != 'ignore-audio-text' else params[1:])
        result = self.audio_operations.get(key)
        previous = self.audio_cache.get(result)
        if previous is None or (not (previous['complete'] and previous['accepted']) and complete and accepted):
            result = digest((key, 'audio-result', len(self.audio_cache) + 1))
            self.audio_cache[result] = {'parameters': params, 'complete': complete, 'accepted': accepted}
            self.audio_operations[key] = result
            if complete and accepted:
                self.accepted_audio_proofs[result] = digest(self.audio_cache[result])
        self.audio_calls.append((params, result))
        self.event('audio-result', result=result, complete=self.audio_cache[result]['complete'])
        return result

    def fulfill(self, rid, tid=None, aid=None):
        req = self.requests[rid]
        if req['status'] == 'cancelled':
            self.event('fulfill-rejected-cancelled', request=rid)
            return False
        text, audio = self.translation_cache.get(tid), self.audio_cache.get(aid)
        ready = req['book'] is not None and text is not None and text['accepted'] and text['complete'] and text['parameters'][0] == req['book']
        ready = ready and (not req['needsAudio'] or (audio is not None and audio['complete'] and audio['accepted'] and audio['parameters'][0] == tid))
        if self.mutant == 'book-is-enough' and req['book']:
            ready = True
        if ready:
            req.update(status='satisfied', translation=tid, audio=aid)
        self.event('fulfill', request=rid, ready=ready)
        return ready

    def download(self, pid, crash=None, corrupt=False):
        if not self.server:
            self.event('download-waiting-server')
            return False
        sha = self.publications[pid]['hash']
        self.local_staging = (pid, sha, self.files[sha] + (b'corrupt' if corrupt else b''))
        if self.mutant == 'index-before-file':
            self.local_index[pid] = sha
            self.event('premature-index')
        if crash == 'staging':
            self.event('download-crash-staging')
            return False
        if digest(self.local_staging[2]) != sha:
            self.event('download-hash-rejected')
            self.local_staging = None
            return False
        self.local_files[sha] = self.local_staging[2]
        if crash == 'after-file':
            self.event('download-crash-after-file')
            return False
        self.local_index[pid] = sha
        self.local_staging = None
        self.event('download-index-committed')
        return True

    def recover_local(self):
        if self.local_staging:
            pid, sha, data = self.local_staging
            if sha in self.local_files and digest(self.local_files[sha]) == sha:
                self.local_index[pid] = sha
            self.local_staging = None
        self.event('local-reconcile')

    def read_local(self, pid, auth=False):
        sha = self.local_index.get(pid)
        expected = sha in self.local_files and digest(self.local_files[sha]) == sha
        observed = expected and (auth or self.mutant != 'offline-requires-auth')
        self.read_checks.append((expected, observed))
        self.event('read-local', auth=auth, server=self.server, success=observed)
        return observed

    def add_shared_reference(self, pid):
        self.publications['shared-copy'] = dict(self.publications[pid])
        self.jobs['shared-copy'] = {'status': 'succeeded'}
        self.event('shared-reference')

    def delete_reference(self, pid):
        sha = self.publications.pop(pid)['hash']
        if self.mutant == 'delete-shared-bytes' or not any(p['hash'] == sha for p in self.publications.values()):
            self.files.pop(sha, None)
        self.event('delete-reference', publication=pid)


FAULTS = ('input-changed', 'output-changed', 'scanner-offline', 'identity-mismatch', 'lease-expired', 'before-commit', 'after-commit', 'cleanup-failed', 'low-resources', 'cancel-A', 'revoke-A', 'download-staging-crash', 'download-file-crash', 'corrupt-download', 'partial-translation', 'partial-audio', 'offline-before-download', 'translation-provider-missing', 'tts-provider-missing')
MUTANTS = {'duplicate-command': 'COMMAND_IDEMPOTENCY', 'reuse-loses-initiator': 'INITIATOR_PRESERVED', 'cancel-shared-job': 'ONE_CANCEL_DOES_NOT_CANCEL_OTHER_REQUESTS', 'ignore-resources': 'HEAVY_ADMISSION_RESPECTS_RESOURCES', 'accept-stale-worker': 'STALE_WORKER_REJECTED', 'cached-grant': 'AUTHORITY_AT_COMMIT', 'skip-security-gate': 'SECURITY_GATE_BOUND_TO_BYTES', 'cleanup-fails-import': 'POST_COMMIT_FAILURE_IS_NOT_IMPORT_FAILURE', 'ignore-glossary': 'TRANSLATION_VARIANTS_SEPARATE', 'ignore-audio-text': 'AUDIO_PINNED_TO_TEXT_AND_VOICE', 'book-is-enough': 'BOOK_READY_IS_NOT_AUDIO_READY', 'index-before-file': 'LOCAL_INDEX_HAS_VERIFIED_BYTES', 'offline-requires-auth': 'OFFLINE_READING_INDEPENDENT_OF_SESSION', 'delete-shared-bytes': 'PUBLISHED_BYTES_EXIST', 'implicit-translation-grant': 'TRANSLATION_GRANT_IS_INDEPENDENT', 'implicit-tts-grant': 'TTS_GRANT_IS_INDEPENDENT'}


def run_trace(seed, faults=(), mutant=None):
    rng, m = random.Random(seed), LibraryModel(mutant)
    m.event('schedule', seed=seed, faults=list(faults))
    body = {'title': 'Книга-' + str(seed % 11), 'audio': True}
    actors, requests = ['A', 'B'], {}
    rng.shuffle(actors)
    for actor in actors:
        requests[actor] = m.submit(actor, 'same-key' if actor == 'A' else 'other-key', body)
    a, b = requests['A'], requests['B']
    for actor in rng.choices(actors, k=rng.randint(2, 5)):
        m.submit(actor, 'same-key' if actor == 'A' else 'other-key', body)
    m.fail_unless(m.submit('A', 'same-key', {**body, 'title': 'other'}) is None, 'BODY_CONFLICT_REJECTED')
    if 'cancel-A' in faults or mutant == 'cancel-shared-job':
        m.cancel(a)
    if 'revoke-A' in faults:
        m.grants['A'] = False
        m.event('grant-revoked-A')
    if 'low-resources' in faults or mutant == 'ignore-resources':
        m.resources = False
        m.fail_unless(m.claim() is None, 'LOW_RESOURCES_WAITS')
        m.resources = True
    fence = m.claim()
    m.prepare(scanner='scanner-offline' not in faults, identity='identity-mismatch' not in faults)
    if 'input-changed' in faults:
        m.input_bytes += b'tampered'
    if 'output-changed' in faults:
        m.output_bytes += b'tampered'
    if 'lease-expired' in faults or mutant == 'accept-stale-worker':
        for _ in range(rng.randint(1, 3)):
            m.expire()
    if mutant == 'cached-grant':
        m.grants.update(A=False, B=False)
    crash = 'before-commit' if 'before-commit' in faults else 'after-commit' if 'after-commit' in faults else None
    pid = m.publish(fence, crash)
    if not pid:
        m.grants['B'] = True
        m.input_bytes = b'original-source-1'
        fence = m.claim()
        m.prepare()
        pid = m.publish(fence, 'after-commit' if 'after-commit' in faults else None)
    m.fail_unless(pid == 'book@1', 'EVENTUAL_ORIGINAL_WITH_HEALTHY_DEPENDENCIES')
    if 'cleanup-failed' in faults or mutant == 'cleanup-fails-import':
        if mutant == 'cleanup-fails-import':
            m.jobs[pid]['status'] = 'failed'
        m.event('cleanup-failed-retained-publication')
    m.publish(fence)
    m.fail_unless(len(m.publications) == 1, 'ONE_PUBLICATION_PER_OPERATION')
    for actor in ('A', 'B'):
        m.capabilities[actor].discard('translate')
    m.fail_unless(m.translate(pid) is None, 'NO_IMPLICIT_TRANSLATION_RIGHT')
    for actor in ('A', 'B'):
        m.capabilities[actor].add('translate')
    if 'translation-provider-missing' in faults:
        m.providers['translate'] = False
        m.fail_unless(m.translate(pid) is None, 'MISSING_TRANSLATOR_IS_NOT_SUCCESS')
        m.fail_unless(not m.fulfill(b), 'NO_TRANSLATION_RESULT_IS_NOT_SUCCESS')
        m.providers['translate'] = True
    if 'partial-translation' in faults:
        partial = m.translate(pid, variant='sample', complete=False)
        m.fail_unless(not m.fulfill(b, partial), 'PARTIAL_TEXT_NOT_SATISFIED')
    tid = m.translate(pid)
    m.fulfill(b, tid)
    for actor in ('A', 'B'):
        m.capabilities[actor].discard('tts')
    m.fail_unless(m.narrate(tid) is None, 'NO_IMPLICIT_TTS_RIGHT')
    for actor in ('A', 'B'):
        m.capabilities[actor].add('tts')
    if 'tts-provider-missing' in faults:
        m.providers['tts'] = False
        m.fail_unless(m.narrate(tid) is None, 'MISSING_NARRATOR_IS_NOT_SUCCESS')
        m.fail_unless(not m.fulfill(b, tid), 'NO_AUDIO_RESULT_IS_NOT_SUCCESS')
        m.providers['tts'] = True
    first_audio = m.narrate(tid)
    second_text = m.translate(pid, glossary='G2', variant='revised')
    second_audio = m.narrate(second_text)
    m.fail_unless(tid != second_text and first_audio != second_audio, 'VARIANTS_DO_NOT_OVERWRITE')
    if 'partial-audio' in faults:
        partial_audio = m.narrate(tid, voice='sample-voice', complete=False)
        m.fail_unless(not m.fulfill(b, tid, partial_audio), 'PARTIAL_AUDIO_NOT_SATISFIED')
    m.fail_unless(m.fulfill(b, tid, first_audio), 'COMPLETE_BUNDLE_SATISFIES')
    if 'offline-before-download' in faults:
        m.server = False
        m.fail_unless(not m.download(pid), 'OFFLINE_CANNOT_FETCH_NEW_BYTES')
        m.server = True
    if 'corrupt-download' in faults:
        m.fail_unless(not m.download(pid, corrupt=True), 'CORRUPT_DOWNLOAD_REJECTED')
    for local_fault, crash_point in [('download-staging-crash', 'staging'), ('download-file-crash', 'after-file')]:
        if local_fault in faults:
            m.download(pid, crash=crash_point)
            m.recover_local()
    if pid not in m.local_index:
        m.download(pid)
    m.server = False
    m.fail_unless(m.read_local(pid, auth=False), 'COLD_OFFLINE_READ_WORKS')
    m.add_shared_reference(pid)
    m.delete_reference('shared-copy')
    # A new source revision creates a distinct publication and translation line.
    old_hash = m.publications[pid]['hash']
    m.source_revision = 2
    m.input_bytes = ('original-source-2-' + str(rng.randrange(100000))).encode()
    m.submit('B', 'new-revision', {'title': body['title'], 'revision': 2, 'audio': True})
    f2 = m.claim()
    m.prepare()
    p2 = m.publish(f2)
    t2 = m.translate(p2)
    m.narrate(t2)
    m.fail_unless(m.publications[pid]['hash'] == old_hash and p2 != pid and t2 != tid, 'SOURCE_UPDATE_PRESERVES_OLD_REVISION')
    m.check()
    return m


def run_suite(seeds=64):
    started = time.perf_counter()
    fault_sets = [(), *((f,) for f in FAULTS), *itertools.combinations(FAULTS, 2)]
    checks, steps, counts, fault_coverage = 0, 0, collections.Counter(), collections.Counter()
    for seed in range(seeds):
        for faults in fault_sets:
            model = run_trace(seed, faults)
            checks += model.checks
            steps += len(model.trace)
            counts[len(faults)] += 1
            fault_coverage.update(faults)
    mutations = []
    for mutant, expected in MUTANTS.items():
        found = None
        for faults in fault_sets:
            try:
                run_trace(0, faults, mutant)
            except Violation as exc:
                if exc.code != expected:
                    raise AssertionError(f'Mutant {mutant} detected by unintended invariant {exc.code}; expected {expected}') from exc
                found = {'mutant': mutant, 'detected': True, 'invariant': exc.code, 'expectedInvariant': expected, 'faults': faults, 'counterexamplePrefix': exc.trace}
                break
        if found is None:
            raise AssertionError('Surviving mutant: ' + mutant)
        mutations.append(found)
    return {'schemaVersion': 1, 'scope': 'EXECUTED_FINITE_PROTOCOL_MODEL_ONLY_NOT_PRODUCTION_SERVER_TESTS', 'seedRange': [0, seeds - 1], 'traces': sum(counts.values()), 'steps': steps, 'assertions': checks, 'faultTypes': len(FAULTS), 'faultCombinationsPerSeed': len(fault_sets), 'traceCountsByFaultCount': dict(counts), 'faultCoverage': dict(fault_coverage), 'mutantsInjected': len(MUTANTS), 'mutantsDetected': len(mutations), 'counterexamplesArePrefixesNotProvenMinimal': True, 'mutations': mutations, 'seconds': round(time.perf_counter() - started, 3), 'productionScenarioCatalogStatus': '32000 specification cases remain NOT_EXECUTED; these are different model traces', 'limitations': ['Model assumes correct hash computation and atomic individual state assignments; it does not execute PostgreSQL, filesystem durability, scanner, parser, network, OS or models.', 'Fault pairs cover the declared schedule points, not every possible interleaving or arbitrary combinations.', 'Translation and audio quality are acceptance flags here, not measured language quality or listening tests.', 'No claim of absolute malware protection or zero errors follows from model success.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seeds', type=int, default=64)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seeds <= 256:
        parser.error('--seeds must be 1–256')
    report = run_suite(args.seeds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('scope', 'traces', 'steps', 'assertions', 'mutantsInjected', 'mutantsDetected', 'seconds')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
