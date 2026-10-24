import concurrent.futures as futures,importlib.util,json,pathlib
root=pathlib.Path(__file__).resolve().parents[1];folder=root/'docs/gargantua/research'
spec=importlib.util.spec_from_file_location('collector',root/'scripts/research-library.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
records=json.loads((folder/'projects-reviewed.json').read_text(encoding='utf-8'))
def one(entry):
 if entry['build_evidence']['sources']:return entry
 candidates={'app/build.gradle.kts':'Gradle/Android','app/build.gradle':'Gradle/Android','build.gradle.kts':'Gradle/JVM','CMakeLists.txt':'CMake','meson.build':'Meson','pubspec.yaml':'Dart/Flutter','go.mod':'Go','Cargo.toml':'Rust','Makefile':'Make','pom.xml':'Maven/JVM','setup.py':'Python','pyproject.toml':'Python','requirements.txt':'Python','Package.swift':'Swift'}
 for filename,kind in candidates.items():
  content,meta=m.fetch(f'https://raw.githubusercontent.com/{entry["repo"]}/HEAD/{filename}','build-manifest')
  if content:
   entry['build_evidence']['sources'].append(meta);entry['build_evidence']['confirmed_declarations'].append({'name':kind,'source':meta['url']});break
 return entry
with futures.ThreadPoolExecutor(max_workers=5) as pool:records=list(pool.map(one,records))
(folder/'projects-reviewed.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
print('build manifests',sum(bool(x['build_evidence']['sources']) for x in records),'of',len(records))
