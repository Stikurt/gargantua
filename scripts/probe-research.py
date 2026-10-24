import importlib.util,pathlib,re,json
p=pathlib.Path(__file__).with_name('research-library.py');spec=importlib.util.spec_from_file_location('collect',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s,meta=m.fetch('https://github.com/janeczku/calibre-web/issues/3731','issue-detail')
print(meta)
for pattern in ['application/ld+json','"body":','"bodyHTML":','articleBody','"defaultBranch"']:
 pos=s.find(pattern);print(pattern,pos,s[max(0,pos-50):pos+280])
