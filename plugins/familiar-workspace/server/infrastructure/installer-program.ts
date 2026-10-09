/** Extract only regular executable members; never unpack an archive into the user's filesystem. */
export const INFRASTRUCTURE_INSTALLER = String.raw`
import hashlib, json, os, pathlib, shutil, sys, tarfile, tempfile, urllib.request, zipfile
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_BINARY_BYTES = 512 * 1024 * 1024
def is_within(child, parent):
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False
def digest(file):
    checksum = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): checksum.update(chunk)
    return checksum.hexdigest()
def download(asset, destination):
    headers = {}
    if asset.get('tokenUrl'):
        with urllib.request.urlopen(asset['tokenUrl'], timeout=30) as response:
            headers['Authorization'] = 'Bearer ' + json.load(response)['token']
    with urllib.request.urlopen(urllib.request.Request(asset['url'], headers=headers), timeout=30) as response, open(destination, 'xb') as stream:
        length = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk: break
            length += len(chunk)
            if length > MAX_ARCHIVE_BYTES: raise RuntimeError('Native archive exceeds size limit')
            stream.write(chunk)
    if digest(destination) != asset['sha256']:
        raise RuntimeError('Native release integrity check failed')
def extract(file, asset, destination):
    name = asset['binary']
    exact = asset.get('member')
    if zipfile.is_zipfile(file):
        with zipfile.ZipFile(file) as archive:
            found = [m for m in archive.infolist() if not m.is_dir() and pathlib.PurePosixPath(m.filename).name == name]
            if len(found) != 1 or found[0].file_size > MAX_BINARY_BYTES or (found[0].external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('Native executable member is invalid')
            with archive.open(found[0]) as source, open(destination, 'xb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
    else:
        with tarfile.open(file) as archive:
            found = [m for m in archive.getmembers() if m.isfile() and (m.name.lstrip('./') == exact if exact else pathlib.PurePosixPath(m.name).name == name)]
            if len(found) != 1 or found[0].size > MAX_BINARY_BYTES:
                raise RuntimeError('Native executable member is invalid')
            with archive.extractfile(found[0]) as source, open(destination, 'xb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
def main():
    spec = json.loads(sys.argv[1])
    root = pathlib.Path(spec['root']) / 'tools'
    versions = root / 'native' / spec['id']
    target = versions / spec['version']
    bin_dir = root / 'bin'
    versions.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.install-', dir=versions))
    try:
        for asset in spec['assets']:
            binary = temporary / asset['binary']
            archive = temporary / (asset['binary'] + '.archive')
            download(asset, archive)
            extract(archive, asset, binary)
            archive.unlink()
            binary.chmod(0o755)
        for asset in spec['assets']:
            entry = bin_dir / asset['binary']
            if os.path.lexists(entry) and (not entry.is_symlink() or not is_within(entry.resolve(), versions.resolve())):
                raise RuntimeError('Existing executable is not owned by this installer; preserved: ' + asset['binary'])
        if target.exists():
            for asset in spec['assets']:
                old = target / asset['binary']
                if old.is_symlink() or not old.is_file() or digest(old) != digest(temporary / asset['binary']):
                    raise RuntimeError('Existing native version differs; preserved')
        else:
            temporary.rename(target)
        for asset in spec['assets']:
            entry = bin_dir / asset['binary']
            link = bin_dir / ('.link-' + asset['binary'] + '-' + str(os.getpid()))
            try:
                link.symlink_to(target / asset['binary'])
                link.replace(entry)
            finally:
                if os.path.lexists(link): link.unlink()
        print(spec['id'] + ' ' + spec['version'] + ' installed. Configure its original connection before running a task.')
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;
