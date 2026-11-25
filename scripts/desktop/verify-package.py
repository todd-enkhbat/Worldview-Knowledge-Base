"""Inspect the built public app ZIP without extracting or printing private credentials."""
from pathlib import Path, PurePosixPath
import hashlib,json,os,posixpath,stat,zipfile

root=Path(__file__).resolve().parents[2]
archive_path=root/'data/desktop/releases/Worldview-mac-arm64.zip'
bundle=root/'data/desktop/releases/Worldview-darwin-arm64/Worldview.app'
build=json.loads((root/'data/desktop/releases/worldview-desktop-build.json').read_text())
secret_values={}
private_credential_read_errors=[]
env=root/'.env.local'
if env.exists():
    for line in env.read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'):continue
        key,value=line.split('=',1);key=key.strip();value=value.strip().strip('"\'')
        if len(value)>=16 and (key.endswith('_API_KEY') or key.endswith('_CLIENT_SECRET') or key.endswith('_BOT_TOKEN')):secret_values[key]=value.encode()
google_private=root/'data/connections/google-drive.private.json'
if google_private.exists():
    try:
        google=json.loads(google_private.read_text())
        if not isinstance(google,dict):raise ValueError('Invalid private credential record')
        tokens=google.get('tokens')
        if not isinstance(tokens,dict):tokens={}
        for label,value in [('googleDrive.clientSecret',google.get('clientSecret')),('googleDrive.tokens.access',tokens.get('access')),('googleDrive.tokens.refresh',tokens.get('refresh'))]:
            if isinstance(value,str) and len(value)>=16:secret_values[label]=value.encode()
    except (OSError,UnicodeError,ValueError):
        # Only symbolic labels leave this process; never log credentials or an
        # exception that could include private JSON contents.
        private_credential_read_errors.append('googleDrive.privateCredentialFile')
crm_private=root/'data/connections/crm-google.private.json'
if crm_private.exists():
    try:
        crm=json.loads(crm_private.read_text())
        if not isinstance(crm,dict) or not isinstance(crm.get('accounts'),list):raise ValueError('Invalid private credential record')
        for index,account in enumerate(crm['accounts']):
            if not isinstance(account,dict):raise ValueError('Invalid private account')
            client=account.get('client') or {};tokens=account.get('tokens') or {}
            for label,value in [('clientSecret',client.get('clientSecret')),('access',tokens.get('access')),('refresh',tokens.get('refresh'))]:
                if isinstance(value,str) and len(value)>=16:secret_values[f'crm.account{index}.{label}']=value.encode()
        for label in ['happenstanceKey','folkKey']:
            value=crm.get(label)
            if isinstance(value,str) and len(value)>=16:secret_values['crm.'+label]=value.encode()
    except (OSError,UnicodeError,ValueError,AttributeError):
        private_credential_read_errors.append('crm.privateCredentialFile')
forbidden=[];outside_links=[];matches=set();count=0;checked=0
prefix='Worldview.app/Contents/Resources/app/'
critical={
 'electron/main.cjs':'electron/main.cjs','electron/preload.cjs':'electron/preload.cjs','electron/policy.cjs':'electron/policy.cjs',
 'server/host.ts':'runtime/server/host.ts','server/memoryAccess.ts':'runtime/server/memoryAccess.ts','server/memoryHttp.ts':'runtime/server/memoryHttp.ts',
 'server/connections/assistant.ts':'runtime/server/connections/assistant.ts','server/connections/googleDrive.ts':'runtime/server/connections/googleDrive.ts','server/connections/desktop.ts':'runtime/server/connections/desktop.ts',
 'scripts/desktop/server.mjs':'runtime/scripts/desktop/server.mjs','src/bookshelf/model.ts':'runtime/src/bookshelf/model.ts','src/data/worldSnapshot.ts':'runtime/src/data/worldSnapshot.ts',
}
critical_matches={};source_matches=0;missing_source=[];different_source=[]
with zipfile.ZipFile(archive_path) as archive:
    names=set(archive.namelist())
    for item in archive.infolist():
        name=item.filename;count+=1
        if name.endswith(('/.env.local','/world.sqlite','/google-drive.private.json','/crm-google.private.json','/crm-authorization-pending.json','/workspace.json')) or '/runtime/data/' in name or '/runtime/blobs/' in name:forbidden.append(name)
        if stat.S_ISLNK(item.external_attr>>16):
            target=archive.read(item).decode('utf-8')
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target))
            if target.startswith('/') or not resolved.startswith('Worldview.app/'):outside_links.append({'path':name,'target':target})
        if secret_values and PurePosixPath(name).suffix.lower() in {'.js','.ts','.json','.mjs','.cjs','.css','.html','.map','.txt'}:
            data=archive.read(item);checked+=1
            for key,value in secret_values.items():
                if value in data:matches.add(key)
    for source,target in critical.items():
        expected=(root/source).read_bytes();actual=archive.read(prefix+target)
        critical_matches[source]=hashlib.sha256(expected).hexdigest()==hashlib.sha256(actual).hexdigest()
    for directory,destination in [('server','runtime/server'),('src','runtime/src'),('dist','dist'),('electron','electron'),('extensions/worldview-reader','runtime/extensions/worldview-reader')]:
        for source in (root/directory).rglob('*'):
            if not source.is_file():continue
            member=prefix+destination+'/'+source.relative_to(root/directory).as_posix()
            if member not in names:missing_source.append(str(source.relative_to(root)));continue
            if hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(archive.read(member)).digest():different_source.append(str(source.relative_to(root)))
            else:source_matches+=1
    executable_entries=['Worldview.app/Contents/MacOS/Worldview',prefix+'runtime/node/bin/node']
    executable_modes={name:bool((archive.getinfo(name).external_attr>>16)&0o111) for name in executable_entries}
    node_digest=hashlib.sha256(archive.read(prefix+'runtime/node/bin/node')).hexdigest()
source_node=root/'data/tools/desktop-node/26.5.0-darwin-arm64/bin/node'
node_matches=node_digest==hashlib.sha256(source_node.read_bytes()).hexdigest()
hash_state=hashlib.sha256()
with archive_path.open('rb') as source:
    for chunk in iter(lambda:source.read(1024*1024),b''):hash_state.update(chunk)
passed=not forbidden and not outside_links and not matches and not private_credential_read_errors and all(critical_matches.values()) and not missing_source and not different_source and all(executable_modes.values()) and node_matches
report={
 'schemaVersion':1,'result':'passed' if passed else 'failed','zip':str(archive_path),'app':str(bundle),'bytes':archive_path.stat().st_size,'sha256':hash_state.hexdigest(),'entries':count,
 'versions':{'electron':build['electron'],'node':build['node']['version']},'signing':build.get('signing'),
 'privacy':{'forbiddenPrivatePaths':forbidden,'configuredSecretMatches':sorted(matches),'configuredSecretsChecked':len(secret_values),'configuredSecretLabelsChecked':sorted(secret_values),'privateCredentialReadErrors':private_credential_read_errors,'textEntriesInspected':checked},
 'links':{'outsideBundle':outside_links},'criticalSourceMatches':critical_matches,'sourceTree':{'matched':source_matches,'missing':missing_source,'different':different_source},
 'executables':executable_modes,'officialNodeBinaryMatchesVerifiedRuntime':node_matches,
 'nativeWindow':{'verified':False,'note':'Separate direct computer-use acceptance is required; a package or HTTP check is not native-window proof.'}
}
output=root/'docs/evaluations/desktop-app-acceptance-2026-11-23.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'result':report['result'],'bytes':report['bytes'],'sha256':report['sha256'],'entries':count,'sourceFilesMatched':source_matches,'privatePaths':len(forbidden),'secretMatches':len(matches),'privateCredentialReadErrors':len(private_credential_read_errors),'escapingLinks':len(outside_links),'report':str(output)},indent=2))
if not passed:raise SystemExit(1)
