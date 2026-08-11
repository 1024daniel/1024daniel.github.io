export OSS_ACCESS_KEY_ID='LTAI5t8sGxxxxxxxxxxx'
export OSS_ACCESS_KEY_SECRET='4smcueH2sH4xxxxxxxxxxxxxxx'

export MYSQL_USER='adminxxxxxxxxxxxxx'
export MYSQL_PASSWORD='3hPVaxxxxxxxxxxxx'

export MYSQL_HOST="rm-bp1d50xxxxxxxxxxxxx.rwlb.rds.aliyuncs.com"
export MYSQL_DATABASE="album" # album
export MYSQL_PHOTO_TABLE="${MYSQL_PHOTO_TABLE:-dishes}"
export OSS_PREFIX="${OSS_PREFIX:-dishes/}"

python oss_batch_to_mysql.py "$@"
